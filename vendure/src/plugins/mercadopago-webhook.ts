import { PluginCommonModule, VendurePlugin, Logger } from '@vendure/core';
import { TransactionalConnection, OrderService, RequestContext } from '@vendure/core';
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
  ) {}

  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(bodyParser.json(), (req: Request, res: Response, next: NextFunction) => {
        this.handleWebhook(req, res).catch((err) => {
          Logger.error(`Webhook error: ${err.message}`, loggerCtx);
          res.status(200).send('OK');
        });
      })
      .forRoutes('mercadopago-webhook');
  }

  private async handleWebhook(req: Request, res: Response) {
    const { type, data } = req.body || {};
    Logger.info(`Webhook received: type=${type}, data=${JSON.stringify(data)}`, loggerCtx);

    if (type !== 'payment') {
      return res.status(200).send('OK');
    }

    const paymentId = data?.id;
    if (!paymentId) {
      Logger.warn('No payment ID in webhook', loggerCtx);
      return res.status(200).send('OK');
    }

    // Find Mercado Pago access token
    const paymentMethods = await this.connection.rawConnection
      .query(`SELECT "handler" FROM "payment_method" WHERE "handler"::text LIKE '%mercado-pago%'`);

    let accessToken = '';
    for (const pm of paymentMethods) {
      try {
        const handler = typeof pm.handler === 'string' ? JSON.parse(pm.handler) : pm.handler;
        if (handler?.code === 'mercado-pago') {
          const tokenArg = handler.args?.find((a: any) => a.name === 'accessToken');
          if (tokenArg) {
            accessToken = tokenArg.value;
            break;
          }
        }
      } catch { /* skip */ }
    }

    if (!accessToken) {
      Logger.error('Could not find Mercado Pago access token', loggerCtx);
      return res.status(200).send('OK');
    }

    // Verify payment with Mercado Pago API
    const mpResponse = await axios.get(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const mpPayment = mpResponse.data;
    const status = mpPayment.status;
    const externalReference = mpPayment.external_reference;

    Logger.info(`Payment ${paymentId}: status=${status}, order=${externalReference}`, loggerCtx);

    if (status === 'approved' && externalReference) {
      const orders = await this.connection.rawConnection
        .query(`SELECT "id", "state" FROM "order" WHERE "code" = $1`, [externalReference]);

      if (orders.length > 0) {
        const order = orders[0];

        if (order.state === 'PaymentAuthorized') {
          // Settle the payment
          await this.connection.rawConnection
            .query(
              `UPDATE "payment" SET "state" = 'Settled', "transactionId" = $1 WHERE "orderId" = $2 AND "method" = 'mercado-pago' AND "state" = 'Authorized'`,
              [String(paymentId), order.id]
            );

          // Transition order using OrderService (fires events → triggers emails)
          try {
            const channels = await this.connection.rawConnection
              .query(`SELECT "id" FROM "channel" WHERE "defaultLanguageCode" IS NOT NULL LIMIT 1`);
            const channelId = channels[0]?.id;

            const ctx = await RequestContext.deserialize({
              _channel: { id: channelId },
              _languageCode: 'en',
              _isAuthorized: true,
              _authorizedAsOwnerOnly: false,
            } as any);

            const transitionResult = await this.orderService.transitionToState(ctx, order.id, 'PaymentSettled');

            if (transitionResult && 'state' in transitionResult && transitionResult.state === 'PaymentSettled') {
              Logger.info(`Order ${externalReference} transitioned to PaymentSettled (email will send)`, loggerCtx);
            } else {
              Logger.warn(`OrderService transition result: ${JSON.stringify(transitionResult)}`, loggerCtx);
              // Fallback
              await this.connection.rawConnection
                .query(
                  `UPDATE "order" SET "state" = 'PaymentSettled' WHERE "id" = $1 AND "state" = 'PaymentAuthorized'`,
                  [order.id]
                );
              Logger.info(`Order ${externalReference} settled via fallback`, loggerCtx);
            }
          } catch (err: any) {
            Logger.error(`Order transition error: ${err.message}`, loggerCtx);
            // Fallback
            await this.connection.rawConnection
              .query(
                `UPDATE "order" SET "state" = 'PaymentSettled' WHERE "id" = $1 AND "state" = 'PaymentAuthorized'`,
                [order.id]
              );
            Logger.info(`Order ${externalReference} settled via fallback after error`, loggerCtx);
          }
        } else {
          Logger.info(`Order ${externalReference} already in state: ${order.state}`, loggerCtx);
        }
      } else {
        Logger.warn(`Order not found for code: ${externalReference}`, loggerCtx);
      }
    }

    return res.status(200).send('OK');
  }
}