// Personal identifiers the BTG portfolio responses may carry. Asset data
// (names, quantities, values) is kept: the user asked for it, in privado/.
// Account/customer identifiers, documents and contact data are never stored.
import { redact } from '../privacy.js';

const personalKey = /^(?:cpf|cnpjCliente|cpfCnpj|document(?:o|Number|Id)?|documentNumber|taxId|account(?:Number|Id|Code)?|accountNumber|conta(?:Corrente)?|numeroConta|nrConta|agencia|branch(?:Number)?|customer(?:Id|Name|Code)?|client(?:Id|Name|Code)?|cliente(?:Id|Nome)?|user(?:Id|Name)?|login|email|e-?mail|phone(?:Number)?|telefone|celular|mobile|birth(?:Date|day)?|dataNascimento|nomeCliente|holder(?:Name|Document)?|titular|password|senha|token|accessToken|refreshToken|idToken|authorization|cookie|otp|signature|tradeId|transferId)$/i;

export function scrubWallet(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(scrubWallet);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, personalKey.test(key) ? '[REMOVIDO]' : scrubWallet(item)]));
  }
  return value;
}
