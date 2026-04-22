import {
  CreatePaymentResult,
  LanguageCode,
  PaymentMethodHandler,
  SettlePaymentResult,
} from '@vendure/core';
import { MercadoPagoConfig, Preference } from 'mercadopago';


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
    // If we receive a payment_id from Mercado Pago webhook/redirect, settle it
    if (metadata.paymentId) {
      return {
        amount,
        state: 'Settled' as const,
        transactionId: metadata.paymentId,
        metadata: {
          public: {
            paymentId: metadata.paymentId,
            status: metadata.status || 'approved',
          },
        },
      };
    }

    // Otherwise create a Checkout Pro preference (redirect flow)
    try {
      const client = getClient(args.accessToken);
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
          notification_url: `https://vendure.dhskateshop.com/mercadopago-webhook`,
        },
      });

      return {
        amount,
        state: 'Authorized' as const,
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
      return {
        amount,
        state: 'Declined' as const,
        metadata: { errorMessage: err.message },
      };
    }
  },

  settlePayment: async (): Promise<SettlePaymentResult> => {
    return { success: true };
  },
});