import {
  CreatePaymentResult,
  LanguageCode,
  Logger,
  PaymentMethodHandler,
  SettlePaymentResult,
} from '@vendure/core';
import { MercadoPagoConfig, Preference } from 'mercadopago';

const loggerCtx = 'MercadoPagoHandler';

function getClient(accessToken: string) {
  return new MercadoPagoConfig({ accessToken });
}

export const mercadoPagoHandler = new PaymentMethodHandler({
  code: 'mercado-pago',
  description: [
    { languageCode: LanguageCode.en, value: 'Mercado Pago' },
    { languageCode: LanguageCode.es, value: 'Mercado Pago' },
  ],
  args: {
    accessToken: { type: 'string' },
  },

  createPayment: async (ctx, order, amount, args, metadata): Promise<CreatePaymentResult> => {
    try {
      const accessToken = String(args.accessToken || '').trim();

      if (!accessToken) {
        return {
          amount,
          state: 'Declined',
          metadata: {
            errorMessage: 'Mercado Pago access token is missing',
          },
        };
      }

      Logger.info(
        `createPayment for order ${order.code}, token prefix=${accessToken.slice(0, 12)}`,
        loggerCtx,
      );

      const client = getClient(accessToken);
      const preference = new Preference(client);

      const result = await preference.create({
        body: {
          items: order.lines.map((line) => ({
            id: line.productVariant.sku,
            title: line.productVariant.name,
            quantity: line.quantity,
            unit_price: line.proratedUnitPriceWithTax / 100,
            currency_id: 'MXN',
          })),
          external_reference: order.code,
          back_urls: {
            success: `https://dhskateshop.com/order/success?code=${order.code}`,
            failure: `https://dhskateshop.com/order/failure?code=${order.code}`,
            pending: `https://dhskateshop.com/order/pending?code=${order.code}`,
          },
          auto_return: 'approved',
          notification_url: 'https://vendure.dhskateshop.com/mercadopago-webhook',
        },
      });

      Logger.info(
        `Preference created for order ${order.code}: preferenceId=${result.id}, initPoint=${result.init_point}, sandboxInitPoint=${result.sandbox_init_point}`,
        loggerCtx,
      );

      return {
        amount,
        state: 'Authorized',
        transactionId: result.id || '',
        metadata: {
          public: {
            preferenceId: result.id,
            initPoint: result.init_point,
            sandboxInitPoint: result.sandbox_init_point,
          },
        },
      };
    } catch (err: any) {
      Logger.error(
        `createPayment failed for order ${order.code}: ${err?.message ?? err}`,
        loggerCtx,
      );

      return {
        amount,
        state: 'Declined',
        metadata: {
          errorMessage: err?.message || 'Mercado Pago preference creation failed',
        },
      };
    }
  },

  settlePayment: async (): Promise<SettlePaymentResult> => {
    return { success: true };
  },
});