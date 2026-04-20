import {
  PluginCommonModule,
  RequestContextService,
  TransactionalConnection,
  OrderService,
  VendurePlugin,
  Logger,
} from '@vendure/core';
import { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import * as bodyParser from 'body-parser';

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
      .apply(
        bodyParser.json(),
        async (req: Request, res: Response, _next: NextFunction) => {
          try {
            await this.handleWebhook(req, res);
          } catch (err: any) {
            Logger.error(`Webhook error: ${err?.message ?? err}`, loggerCtx);

            if (!res.headersSent) {
              res.status(200).send('OK');
            }
          }
        },
      )
      .forRoutes('mercadopago-webhook');
  }

  private async handleWebhook(req: Request, res: Response) {
    const { type, data } = req.body ?? {};

    Logger.info(`Webhook received: ${JSON.stringify(req.body)}`, loggerCtx);
    Logger.info(`x-signature: ${req.headers['x-signature']}`, loggerCtx);
    Logger.info(`x-request-id: ${req.headers['x-request-id']}`, loggerCtx);

    if (type !== 'payment' || !data?.id) {
      return res.status(200).send('OK');
    }

    const paymentId = String(data.id);

    // Respond to Mercado Pago immediately
    res.status(200).send('OK');

    try {
      // Fetch MP access token from configured payment method
      const paymentMethods = await this.connection.rawConnection.query(
        `SELECT "handler" FROM "payment_method" WHERE "handler"::text LIKE '%mercado-pago%'`
      );

      let accessToken = '';
      for (const pm of paymentMethods) {
        try {
          const handler =
            typeof pm.handler === 'string' ? JSON.parse(pm.handler) : pm.handler;

          if (handler?.code === 'mercado-pago') {
            const tokenArg = handler.args?.find((a: any) => a.name === 'accessToken');
            if (tokenArg?.value) {
              accessToken = tokenArg.value;
              break;
            }
          }
        } catch {}
      }

      if (!accessToken) {
        Logger.error('Mercado Pago access token not found', loggerCtx);
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
          `Could not fetch Mercado Pago payment ${paymentId}. Probably simulator/fake id. Error: ${err?.message}`,
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

      if (!vendurePayment.transactionId) {
        vendurePayment.transactionId = paymentId;
        await paymentRepo.save(vendurePayment);
      }

      const ctx = await this.requestContextService.create({
        apiType: 'admin',
        channelOrToken: order.channels?.[0],
      });

      const result = await this.orderService.settlePayment(ctx, vendurePayment.id);

      Logger.info(
        `settlePayment result for order ${externalReference}: ${JSON.stringify(result)}`,
        loggerCtx,
      );
    } catch (err: any) {
      Logger.error(
        `Post-ack webhook processing failed for payment ${paymentId}: ${err?.message ?? err}`,
        loggerCtx,
      );
    }
  }
}