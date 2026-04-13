import { LanguageCode, ShippingCalculator, Logger } from '@vendure/core';
import axios from 'axios';

const loggerCtx = 'SkydropxShippingCalculator';
const SKYDROPX_BASE_URL = 'https://api-pro.skydropx.com';
const REQUEST_TIMEOUT_MS = 15000;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Cache the OAuth token
let skydropxToken: string | null = null;
let tokenExpiry = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstNonEmpty(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return undefined;
}

function normalizeCarrier(value: string): string {
  return value.trim().toLowerCase();
}

function parseMoneyValue(value: unknown, fallback = Number.POSITIVE_INFINITY): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
}

function formatSkydropxError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const data = err.response?.data;

    let details = err.message;

    if (typeof data === 'string') {
      details = data;
    } else if (data && typeof data === 'object') {
      try {
        details = JSON.stringify(data);
      } catch {
        details = err.message;
      }
    }

    return status ? `[${status}] ${details}` : details;
  }

  if (err instanceof Error) {
    return err.message;
  }

  return String(err);
}

async function getToken(clientId: string, clientSecret: string): Promise<string> {
  const now = Date.now();

  if (skydropxToken && now < tokenExpiry) {
    return skydropxToken;
  }

  const res = await axios.post(
    `${SKYDROPX_BASE_URL}/api/v1/oauth/token`,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: REQUEST_TIMEOUT_MS,
    },
  );

  const accessToken = res.data?.access_token;
  const expiresIn = Number(res.data?.expires_in ?? 7200);

  if (!accessToken || typeof accessToken !== 'string') {
    throw new Error('Skydropx token response did not include access_token');
  }

  skydropxToken = accessToken;
  tokenExpiry = now + Math.max(expiresIn * 1000 - TOKEN_REFRESH_BUFFER_MS, 60_000);

  Logger.info('Skydropx token acquired successfully', loggerCtx);
  return skydropxToken;
}

export const skydropxShippingCalculator = new ShippingCalculator({
  code: 'skydropx-rates-calculator',
  description: [
    { languageCode: LanguageCode.en, value: 'Skydropx Live Rates' },
    { languageCode: LanguageCode.es, value: 'Tarifas Skydropx en vivo' },
  ],

  args: {
    clientId: {
      type: 'string',
      label: [{ languageCode: LanguageCode.en, value: 'Client ID (API Key)' }],
    },
    clientSecret: {
      type: 'string',
      label: [{ languageCode: LanguageCode.en, value: 'Client Secret' }],
    },
    originPostalCode: {
      type: 'string',
      defaultValue: '20000',
      label: [{ languageCode: LanguageCode.en, value: 'Origin Postal Code' }],
    },
    originState: {
      type: 'string',
      defaultValue: 'Aguascalientes',
      label: [{ languageCode: LanguageCode.en, value: 'Origin State' }],
    },
    originCity: {
      type: 'string',
      defaultValue: 'Aguascalientes',
      label: [{ languageCode: LanguageCode.en, value: 'Origin City' }],
    },
    originNeighborhood: {
      type: 'string',
      defaultValue: 'Centro',
      label: [{ languageCode: LanguageCode.en, value: 'Origin Neighborhood (Colonia)' }],
    },
    preferredCarrier: {
      type: 'string',
      defaultValue: '',
      label: [{ languageCode: LanguageCode.en, value: 'Preferred Carrier (optional)' }],
      description: [
        {
          languageCode: LanguageCode.en,
          value: 'e.g. fedex, dhl, estafeta, ups — leave empty for cheapest',
        },
      ],
    },
    fallbackRate: {
      type: 'int',
      defaultValue: 25000,
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
    const customFields = (shippingAddress as any)?.customFields ?? {};

    if (!shippingAddress?.postalCode) {
      return {
        price: 0,
        priceIncludesTax: false,
        taxRate: args.taxRate,
        metadata: {
          error: 'No shipping postal code provided',
        },
      };
    }

    // Calculate total weight in kg (default 1.5kg per item)
    let totalWeightKg = 0;

    for (const line of order.lines) {
      const itemWeightGrams = Number((line.productVariant as any)?.customFields?.weight ?? 1500);
      const safeWeightGrams = Number.isFinite(itemWeightGrams) && itemWeightGrams > 0 ? itemWeightGrams : 1500;
      totalWeightKg += (safeWeightGrams / 1000) * line.quantity;
    }

    totalWeightKg = Math.max(Number(totalWeightKg.toFixed(2)), 0.5);

    const destinationState = firstNonEmpty(
      shippingAddress.province,
      customFields.state,
      customFields.area_level1,
    );

    const destinationCity = firstNonEmpty(
      shippingAddress.city,
      customFields.city,
      customFields.municipality,
      customFields.area_level2,
    );

    const destinationNeighborhood = firstNonEmpty(
      customFields.neighborhood,
      customFields.colonia,
      customFields.suburb,
      customFields.area_level3,
      shippingAddress.streetLine2,
      shippingAddress.streetLine1,
      destinationCity,
    );

    if (!destinationState || !destinationCity || !destinationNeighborhood) {
      const missingFields = [
        !destinationState ? 'area_level1/state' : null,
        !destinationCity ? 'area_level2/city' : null,
        !destinationNeighborhood ? 'area_level3/neighborhood' : null,
      ]
        .filter(Boolean)
        .join(', ');

      Logger.warn(
        `Incomplete destination address for Skydropx quotation. Missing: ${missingFields}`,
        loggerCtx,
      );

      return {
        price: args.fallbackRate,
        priceIncludesTax: false,
        taxRate: args.taxRate,
        metadata: {
          error: `Incomplete destination address for Skydropx: ${missingFields}`,
          service: 'Envío estándar (estimado)',
        },
      };
    }

    try {
      const token = await getToken(args.clientId, args.clientSecret);

      const requestBody: Record<string, any> = {
        quotation: {
          order_id: String(order.code ?? order.id ?? ''),
          address_from: {
            country_code: 'MX',
            postal_code: args.originPostalCode,
            area_level1: args.originState,
            area_level2: args.originCity,
            area_level3: args.originNeighborhood,
          },
          address_to: {
            country_code: 'MX',
            postal_code: shippingAddress.postalCode,
            area_level1: destinationState,
            area_level2: destinationCity,
            area_level3: destinationNeighborhood,
          },
          parcels: [
            {
              weight: totalWeightKg,
              length: 30,
              width: 20,
              height: 12,
              package_protected: false,
            },
          ],
        },
      };

      const preferredCarrier = typeof args.preferredCarrier === 'string' ? normalizeCarrier(args.preferredCarrier) : '';
      if (preferredCarrier) {
        requestBody.quotation.requested_carriers = [preferredCarrier];
      }

      Logger.info(
        `Creating Skydropx quotation: ${args.originPostalCode} -> ${shippingAddress.postalCode}`,
        loggerCtx,
      );

      const createRes = await axios.post(
        `${SKYDROPX_BASE_URL}/api/v2/quotations`,
        requestBody,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          timeout: REQUEST_TIMEOUT_MS,
        },
      );

      const quotationData = createRes.data ?? {};
      const quotationId = quotationData?.id as string | undefined;
      let rates: any[] = Array.isArray(quotationData?.rates) ? quotationData.rates : [];
      let isCompleted = Boolean(quotationData?.is_completed);

      Logger.info(
        `Quotation created: ${quotationId ?? 'N/A'}, completed: ${isCompleted}, rates: ${rates.length}`,
        loggerCtx,
      );

      // Poll only if needed. If polling fails, keep the original rates instead of failing the whole quote.
      if (!isCompleted && quotationId) {
        let attempts = 0;
        const maxAttempts = 5;

        while (attempts < maxAttempts && !isCompleted && rates.length === 0) {
          attempts += 1;
          await sleep(2000);

          try {
            const getRes = await axios.get(
              `${SKYDROPX_BASE_URL}/api/v1/quotations/${quotationId}`,
              {
                headers: {
                  Authorization: `Bearer ${token}`,
                  Accept: 'application/json',
                },
                timeout: REQUEST_TIMEOUT_MS,
              },
            );

            const pollData = getRes.data ?? {};
            isCompleted = Boolean(pollData?.is_completed);
            rates = Array.isArray(pollData?.rates) ? pollData.rates : [];

            Logger.info(
              `Poll attempt ${attempts}: completed=${isCompleted}, rates=${rates.length}`,
              loggerCtx,
            );
          } catch (pollErr) {
            Logger.warn(`Skydropx quotation poll failed: ${formatSkydropxError(pollErr)}`, loggerCtx);
            break;
          }
        }
      }

      const successRates = rates.filter((rate: any) => {
        if (rate?.success !== true) {
          return false;
        }

        const numericTotal = parseMoneyValue(rate?.total, Number.NaN);
        const numericAmount = parseMoneyValue(rate?.amount, Number.NaN);

        return Number.isFinite(numericTotal) || Number.isFinite(numericAmount);
      });

      if (successRates.length === 0) {
        const rawStatuses = rates
          .map((rate: any) => {
            const provider = rate?.provider_name ?? 'unknown';
            const status = rate?.status ?? 'unknown';
            const errors = rate?.error_messages ? JSON.stringify(rate.error_messages) : '';
            return `${provider}:${status}${errors ? `:${errors}` : ''}`;
          })
          .join(' | ');

        Logger.warn(
          `No successful Skydropx rates${rawStatuses ? ` (${rawStatuses})` : ''}`,
          loggerCtx,
        );

        return {
          price: args.fallbackRate,
          priceIncludesTax: false,
          taxRate: args.taxRate,
          metadata: {
            error: 'No Skydropx rates available',
            service: 'Envío estándar',
          },
        };
      }

      let filteredRates = successRates;

      if (preferredCarrier) {
        const carrierFiltered = successRates.filter((rate: any) => {
          const providerName = typeof rate?.provider_name === 'string'
            ? normalizeCarrier(rate.provider_name)
            : '';

          const providerDisplayName = typeof rate?.provider_display_name === 'string'
            ? normalizeCarrier(rate.provider_display_name)
            : '';

          return providerName === preferredCarrier || providerDisplayName === preferredCarrier;
        });

        if (carrierFiltered.length > 0) {
          filteredRates = carrierFiltered;
        }
      }

      const cheapest = filteredRates.reduce((min: any, rate: any) => {
        const ratePrice = parseMoneyValue(rate?.total, parseMoneyValue(rate?.amount));
        const minPrice = parseMoneyValue(min?.total, parseMoneyValue(min?.amount));

        return ratePrice < minPrice ? rate : min;
      }, filteredRates[0]);

      const totalPrice = parseMoneyValue(cheapest?.total, parseMoneyValue(cheapest?.amount, 0));
      const priceInCents = Math.round(totalPrice * 100);
      const provider = cheapest?.provider_display_name || cheapest?.provider_name || 'Skydropx';
      const serviceName = cheapest?.provider_service_name || provider;
      const days = Number(cheapest?.days ?? 0);

      Logger.info(
        `Skydropx rate selected: ${provider} ${serviceName} = $${totalPrice} MXN (${days} days)`,
        loggerCtx,
      );

      return {
        price: priceInCents,
        priceIncludesTax: false,
        taxRate: args.taxRate,
        metadata: {
          quotationId: quotationId ?? '',
          service: `${provider} — ${serviceName}`,
          estimatedDelivery: days > 0 ? `${days} día${days > 1 ? 's' : ''} hábiles` : '',
          totalWeight: `${totalWeightKg} kg`,
          provider: cheapest?.provider_name ?? '',
          rateType: cheapest?.rate_type ?? '',
        },
      };
    } catch (err: any) {
      const status = err.response?.status || 'unknown';
      const fullData = JSON.stringify(err.response?.data || {});
      Logger.error(`Skydropx API error (${status}): ${fullData}`, loggerCtx);

      return {
        price: args.fallbackRate,
        priceIncludesTax: false,
        taxRate: args.taxRate,
        metadata: {
          error: 'Skydropx API unavailable, using fallback',
          service: 'Envío estándar (estimado)',
        },
      };
    }
  },
});