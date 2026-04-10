import { LanguageCode, ShippingCalculator, Logger } from '@vendure/core';
import axios from 'axios';

const loggerCtx = 'SkydropxShippingCalculator';

export const skydropxShippingCalculator = new ShippingCalculator({
  code: 'skydropx-rates-calculator',
  description: [
    { languageCode: LanguageCode.en, value: 'Skydropx Live Rates' },
    { languageCode: LanguageCode.es, value: 'Tarifas Skydropx en vivo' },
  ],
  args: {
    apiKey: {
      type: 'string',
      label: [{ languageCode: LanguageCode.en, value: 'Skydropx API Key' }],
    },
    originPostalCode: {
      type: 'string',
      defaultValue: '20000',
      label: [{ languageCode: LanguageCode.en, value: 'Origin Postal Code' }],
    },
    preferredCarrier: {
      type: 'string',
      defaultValue: '',
      label: [{ languageCode: LanguageCode.en, value: 'Preferred Carrier (optional)' }],
      description: [{ languageCode: LanguageCode.en, value: 'e.g. Fedex, DHL, Estafeta, UPS — leave empty for cheapest across all' }],
    },
    fallbackRate: {
      type: 'int',
      defaultValue: 19900,
      label: [{ languageCode: LanguageCode.en, value: 'Fallback Rate (cents)' }],
      ui: { component: 'currency-form-input' },
    },
    taxRate: {
      type: 'int',
      defaultValue: 16,
      label: [{ languageCode: LanguageCode.en, value: 'Tax Rate %' }],
      ui: { component: 'number-form-input', suffix: '%' },
    },
  },

  calculate: async (ctx, order, args) => {
    const shippingAddress = order.shippingAddress;

    if (!shippingAddress?.postalCode) {
      return {
        price: 0,
        priceIncludesTax: false,
        taxRate: args.taxRate,
        metadata: { error: 'No shipping address provided' },
      };
    }

    // Calculate total weight (default 1.5kg per item if not set)
    let totalWeightKg = 0;
    for (const line of order.lines) {
      const itemWeightGrams = (line.productVariant as any)?.customFields?.weight || 1500;
      totalWeightKg += (itemWeightGrams / 1000) * line.quantity;
    }
    totalWeightKg = Math.max(totalWeightKg, 0.5);

    try {
      const requestBody: any = {
        zip_from: args.originPostalCode,
        zip_to: shippingAddress.postalCode,
        parcel: {
          weight: Math.round(totalWeightKg * 10) / 10,
          height: 12,
          width: 20,
          length: 30,
        },
      };

      // Filter by carrier if specified
      if (args.preferredCarrier) {
        requestBody.carriers = [{ name: args.preferredCarrier }];
      }

      const response = await axios.post(
        'https://api.skydropx.com/v1/quotations',
        requestBody,
        {
          headers: {
            'Authorization': `Token token=${args.apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const rates = response.data;

      if (!rates || !Array.isArray(rates) || rates.length === 0) {
        Logger.warn('No Skydropx rates returned', loggerCtx);
        return {
          price: args.fallbackRate,
          priceIncludesTax: false,
          taxRate: args.taxRate,
          metadata: { error: 'No rates available, using fallback', service: 'Envío estándar' },
        };
      }

      // Find the cheapest rate
      const cheapest = rates.reduce((min: any, r: any) => {
        const price = r.total_pricing || r.amount_local || 999999;
        const minPrice = min.total_pricing || min.amount_local || 999999;
        return price < minPrice ? r : min;
      }, rates[0]);

      const priceInCents = Math.round((cheapest.total_pricing || cheapest.amount_local) * 100);
      const provider = cheapest.provider || 'Skydropx';
      const serviceName = cheapest.service_level_name || provider;
      const days = cheapest.days || 0;
      const outOfArea = cheapest.out_of_area_service || false;

      Logger.info(
        `Skydropx rate: ${provider} ${serviceName} = $${priceInCents / 100} MXN (${days} days)`,
        loggerCtx
      );

      return {
        price: priceInCents,
        priceIncludesTax: false,
        taxRate: args.taxRate,
        metadata: {
          service: `${provider} — ${serviceName}`,
          estimatedDelivery: days > 0 ? `${days} día${days > 1 ? 's' : ''} hábiles` : '',
          totalWeight: `${totalWeightKg} kg`,
          outOfArea: outOfArea ? 'Zona extendida' : '',
        },
      };
    } catch (err: any) {
      const errMsg = err.response?.data?.message || err.message;
      Logger.error(`Skydropx API error: ${errMsg}`, loggerCtx);

      return {
        price: args.fallbackRate,
        priceIncludesTax: false,
        taxRate: args.taxRate,
        metadata: {
          error: 'Skydropx API unavailable, using fallback',
          service: 'Envío estándar (estimado)',
          detail: errMsg,
        },
      };
    }
  },
});