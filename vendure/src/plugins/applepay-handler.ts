import {
  CreatePaymentResult,
  LanguageCode,
  PaymentMethodHandler,
  SettlePaymentResult,
} from '@vendure/core';

export const applePayHandler = new PaymentMethodHandler({
  code: 'apple-pay',
  description: [
    { languageCode: LanguageCode.en, value: 'Apple Pay' },
    { languageCode: LanguageCode.es, value: 'Apple Pay' },
  ],
  args: {
    secretKey: { type: 'string' },
  },

  createPayment: async (ctx, order, amount, args, metadata): Promise<CreatePaymentResult> => {
    try {
      // metadata should contain the PSP authorization result
      // after your frontend submits the Apple Pay token to your backend.

      if (!metadata?.pspPaymentId) {
        return {
          amount,
          state: 'Declined' as const,
          metadata: {
            errorMessage: 'Missing Apple Pay PSP authorization result',
          },
        };
      }

      return {
        amount,
        state: metadata.settled ? ('Settled' as const) : ('Authorized' as const),
        transactionId: metadata.pspPaymentId,
        metadata: {
          public: {
            brand: 'Apple Pay',
            status: metadata.status ?? 'authorized',
          },
        },
      };
    } catch (err: any) {
      return {
        amount,
        state: 'Declined' as const,
        metadata: {
          errorMessage: err.message ?? 'Apple Pay payment failed',
        },
      };
    }
  },

  settlePayment: async (): Promise<SettlePaymentResult> => {
    return { success: true };
  },
});