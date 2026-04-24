import {
  PluginCommonModule,
  RequestContextService,
  TransactionalConnection,
  OrderService,
  VendurePlugin,
  Logger,
} from '@vendure/core';
import { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { Request, Response } from 'express';
import axios from 'axios';

const loggerCtx = 'MercadoPagoWebhook';

@VendurePlugin({
  imports: [PluginCommonModule],
  compatibility: '^3.0.0',
})
export class MercadoPagoWebhookPlugin implements NestModule {
  constructor(
    private connection: TransactionalConnection,
    private orderService: OrderService,
    private requestContextService: RequestContextService,
  ) {}

  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(async (req: Request, res: Response) => {
        try {
          await this.handleWebhook(req, res);
        } catch (err: any) {
          Logger.error(`Webhook error: ${err?.message ?? err}`, loggerCtx);
          if (!res.headersSent) {
            res.status(200).send('OK');
          }
        }
      })
      .forRoutes('mercadopago-webhook');
  }

  private async handleWebhook(req: Request, res: Response) {
    const body = req.body ?? {};

    Logger.info(`Webhook received: ${JSON.stringify(body)}`, loggerCtx);
    Logger.info(`x-signature: ${req.headers['x-signature']}`, loggerCtx);
    Logger.info(`x-request-id: ${req.headers['x-request-id']}`, loggerCtx);

    // Always acknowledge Mercado Pago immediately
    res.status(200).send('OK');

    try {
      const accessToken = await this.getAccessToken();

      if (!accessToken) {
        Logger.error('Mercado Pago access token not found', loggerCtx);
        return;
      }

      Logger.info(`MP token prefix in webhook: ${accessToken.slice(0, 12)}`, loggerCtx);

      let paymentId: string | null = null;

      // Case 1: Webhook payment format
      if (body.type === 'payment' && body.data?.id) {
        paymentId = String(body.data.id);
      }

      // Case 2: topic/resource payment format
      if (!paymentId && body.topic === 'payment' && body.resource) {
        paymentId = String(body.resource).split('/').pop() ?? null;
      }

      // Case 3: Checkout Pro merchant_order format
      if (!paymentId && body.topic === 'merchant_order' && body.resource) {
        const merchantOrderId = String(body.resource).split('/').pop();

        if (!merchantOrderId) {
          Logger.warn('merchant_order webhook had no merchant order id', loggerCtx);
          return;
        }

        const merchantOrderUrl = `https://api.mercadopago.com/merchant_orders/${merchantOrderId}`;

        const merchantOrderResponse = await axios.get(merchantOrderUrl, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });

        const merchantOrder = merchantOrderResponse.data;

        Logger.info(`Merchant order fetched: ${JSON.stringify(merchantOrder)}`, loggerCtx);

        const approvedPayment = merchantOrder.payments?.find(
          (p: any) => p.status === 'approved' || p.status === 'authorized',
        );

        if (!approvedPayment?.id) {
          Logger.info('merchant_order received but no approved/authorized payment found yet', loggerCtx);
          return;
        }

        paymentId = String(approvedPayment.id);
      }

      if (!paymentId) {
        Logger.info('Ignoring webhook: unsupported payload shape', loggerCtx);
        return;
      }

      let mpPayment: any;

      try {
        const mpResponse = await axios.get(
          `https://api.mercadopago.com/v1/payments/${paymentId}`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          },
        );

        mpPayment = mpResponse.data;
      } catch (err: any) {
        Logger.warn(
          `Could not fetch Mercado Pago payment ${paymentId}. Error: ${err?.message}`,
          loggerCtx,
        );
        return;
      }

      const status = mpPayment.status;
      const externalReference = mpPayment.external_reference;

      Logger.info(
        `Mercado Pago payment ${paymentId}: status=${status}, external_reference=${externalReference}`,
        loggerCtx,
      );

      if (status !== 'approved' || !externalReference) {
        Logger.info(
          `Ignoring payment ${paymentId} because status is not approved or external_reference is missing`,
          loggerCtx,
        );
        return;
      }

      const orderRepo = this.connection.getRepository('Order');
      const paymentRepo = this.connection.getRepository('Payment');

      const order = await orderRepo.findOne({
        where: { code: externalReference },
        relations: ['payments', 'customer', 'channels'],
      });

      if (!order) {
        Logger.warn(`Order not found for code ${externalReference}`, loggerCtx);
        return;
      }

      Logger.info(
        `Order found: code=${order.code}, state=${order.state}, customer=${order.customer?.emailAddress ?? 'no-email'}`,
        loggerCtx,
      );

      Logger.info(
        `Order channels: ${JSON.stringify(
          order.channels?.map((c: any) => ({
            id: c.id,
            code: c.code,
            token: c.token,
          })),
        )}`,
        loggerCtx,
      );

      const vendurePayment = order.payments?.find(
        (p: any) =>
          p.method === 'mercado-pago' &&
          (p.state === 'Authorized' || p.state === 'Created'),
      );

      if (!vendurePayment) {
        Logger.warn(
          `No unsettled Mercado Pago payment found for order ${externalReference}`,
          loggerCtx,
        );
        return;
      }

      vendurePayment.transactionId = paymentId;
      await paymentRepo.save(vendurePayment);

      const channelToken = order.channels?.[0]?.token;

      if (!channelToken) {
        Logger.error(`Order ${externalReference} has no channel token`, loggerCtx);
        return;
      }

      const ctx = await this.requestContextService.create({
        apiType: 'admin',
        channelOrToken: channelToken,
      });

      const result = await this.orderService.settlePayment(ctx, vendurePayment.id);

      Logger.info(
        `settlePayment result for order ${externalReference}: ${JSON.stringify(result)}`,
        loggerCtx,
      );
    } catch (err: any) {
      Logger.error(`Post-ack webhook processing failed: ${err?.message ?? err}`, loggerCtx);
    }
  }

  private async getAccessToken(): Promise<string> {
    const paymentMethods = await this.connection.rawConnection.query(
      `SELECT "handler" FROM "payment_method" WHERE "handler"::text LIKE '%mercado-pago%'`,
    );

    for (const pm of paymentMethods) {
      try {
        const handler = typeof pm.handler === 'string' ? JSON.parse(pm.handler) : pm.handler;

        if (handler?.code === 'mercado-pago') {
          const tokenArg = handler.args?.find((a: any) => a.name === 'accessToken');
          if (tokenArg?.value) {
            return String(tokenArg.value);
          }
        }
      } catch {}
    }

    return '';
  }
}