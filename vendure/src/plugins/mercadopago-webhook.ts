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
            res.status(200).send('OK');
          }
        },
      )
      .forRoutes('mercadopago-webhook');
  }

  private async handleWebhook(req: Request, res: Response) {
    const { type, data } = req.body ?? {};
    Logger.info(`Webhook received: ${JSON.stringify(req.body)}`, loggerCtx);

    if (type !== 'payment' || !data?.id) {
      return res.status(200).send('OK');
    }

    const paymentId = String(data.id);

    // Fetch MP access token from your configured payment method
    const paymentMethods = await this.connection.rawConnection.query(
      `SELECT "handler" FROM "payment_method" WHERE "handler"::text LIKE '%mercado-pago%'`
    );

    let accessToken = '';
    for (const pm of paymentMethods) {
      try {
        const handler = typeof pm.handler === 'string' ? JSON.parse(pm.handler) : pm.handler;
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
      return res.status(200).send('OK');
    }

    // Verify with Mercado Pago
    const mpResponse = await axios.get(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    const mpPayment = mpResponse.data;
    const status = mpPayment.status;
    const externalReference = mpPayment.external_reference;

    Logger.info(
      `Mercado Pago payment ${paymentId}: status=${status}, external_reference=${externalReference}`,
      loggerCtx,
    );

    if (status !== 'approved' || !externalReference) {
      return res.status(200).send('OK');
    }

    // Find the Vendure order by code
    const orderRepo = this.connection.getRepository('Order');
    const paymentRepo = this.connection.getRepository('Payment');

    const order = await orderRepo.findOne({
      where: { code: externalReference },
      relations: ['payments', 'customer', 'channels'],
    });

    if (!order) {
      Logger.warn(`Order not found for code ${externalReference}`, loggerCtx);
      return res.status(200).send('OK');
    }

    const vendurePayment = order.payments?.find(
      (p: any) => p.method === 'mercado-pago' && (p.state === 'Authorized' || p.state === 'Created'),
    );

    if (!vendurePayment) {
      Logger.warn(`No unsettled Mercado Pago payment found for order ${externalReference}`, loggerCtx);
      return res.status(200).send('OK');
    }

    // Optional: persist provider transaction id in metadata/custom field if needed
    if (!vendurePayment.transactionId) {
      vendurePayment.transactionId = paymentId;
      await paymentRepo.save(vendurePayment);
    }

    const ctx = await this.requestContextService.create({
      apiType: 'admin',
      channelOrToken: order.channels?.[0],
    });

    const result = await this.orderService.settlePayment(ctx, vendurePayment.id);

    if ((result as any)?.state === 'Settled') {
      Logger.info(`Payment settled for order ${externalReference}`, loggerCtx);
    } else {
      Logger.warn(`Unexpected settlePayment result: ${JSON.stringify(result)}`, loggerCtx);
    }

    return res.status(200).send('OK');
  }
}