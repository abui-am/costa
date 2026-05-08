export type PaymentMethod =
  | 'UNSPECIFIED'
  | 'CASH'
  | 'CREDIT_CARD'
  | 'DEBIT_CARD'
  | 'BANK_TRANSFER'
  | 'E_WALLET'
  | 'QR_PAY'
  | 'OTHER'

export const PAYMENT_METHOD_VALUES: readonly PaymentMethod[] = [
  'UNSPECIFIED',
  'CASH',
  'CREDIT_CARD',
  'DEBIT_CARD',
  'BANK_TRANSFER',
  'E_WALLET',
  'QR_PAY',
  'OTHER',
]

/** Map free-text payment method descriptions (from receipts / user input) to the DB enum. */
export function parsePaymentMethod(raw: string | null | undefined): PaymentMethod {
  const upper = (raw ?? '').trim().toUpperCase() as PaymentMethod
  if (PAYMENT_METHOD_VALUES.includes(upper)) return upper

  const s = (raw ?? '').trim().toLowerCase()
  if (!s) return 'UNSPECIFIED'

  if (['cash', 'tunai', 'uang tunai'].includes(s)) return 'CASH'
  if (['credit card', 'credit', 'kartu kredit', 'cc', 'visa', 'mastercard', 'amex'].includes(s))
    return 'CREDIT_CARD'
  if (['debit card', 'debit', 'kartu debit', 'atm', 'eftpos'].includes(s)) return 'DEBIT_CARD'
  if (['bank transfer', 'transfer', 'wire', 'ach', 'tf', 'transfer bank'].includes(s))
    return 'BANK_TRANSFER'
  if (
    [
      'e-money',
      'e money',
      'emoney',
      'e-wallet',
      'ewallet',
      'gopay',
      'ovo',
      'dana',
      'shopeepay',
      'linkaja',
      'paypal',
      'digital wallet',
    ].includes(s)
  )
    return 'E_WALLET'
  if (['qris', 'qr', 'qr pay', 'qr-pay', 'scan', 'qr code'].includes(s)) return 'QR_PAY'

  return 'OTHER'
}
