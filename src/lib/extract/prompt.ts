// Prompt + forced-tool schema. Asking for BOTH the numeric amount and the model's
// numeric reading of the words lets the client reconcile them deterministically.

export const SYSTEM_PROMPT =
  'You are a meticulous OCR and data-extraction engine for GCC (especially Qatari) bank cheques. ' +
  'Images may be rotated, low-contrast, bilingual (Arabic/English) and contain handwriting. ' +
  'Read every digit exactly, never drop repeated digits, convert Eastern-Arabic numerals to Western ' +
  'digits, and always answer by calling the provided tool with strict, schema-valid values.';

export const EXTRACT_PROMPT =
  'Extract the fields from this single bank cheque. For the amount, report the figures from the ' +
  'amount box as amount_numeric, the courtesy line text as amount_words, and your own numeric ' +
  'reading of those words as amount_words_value. If a field is absent, return an empty string (or ' +
  'null for amount_words_value). The cheque number is the leading digits of the MICR/MRIC line at ' +
  'the bottom. Give a 0..1 confidence per field.';

export const EXTRACT_TOOL = {
  name: 'record_cheque',
  description: 'Return the extracted cheque fields as structured data.',
  input_schema: {
    type: 'object',
    properties: {
      amount_numeric: { type: 'string', description: 'Amount as digits from the amount box' },
      amount_words: { type: 'string', description: 'Courtesy/written amount line, verbatim' },
      amount_words_value: { type: ['number', 'null'], description: 'Numeric value of the written words' },
      currency: { type: 'string' },
      date: { type: 'string', description: 'Cheque date as written' },
      payer: { type: 'string', description: 'Account holder / drawer name' },
      bank: { type: 'string' },
      cheque_number: { type: 'string', description: 'Leading digits of the MICR line' },
      has_handwriting: { type: 'boolean' },
      field_confidence: {
        type: 'object',
        properties: {
          amount: { type: 'number' },
          date: { type: 'number' },
          payer: { type: 'number' },
          bank: { type: 'number' },
          chequeNumber: { type: 'number' }
        }
      }
    },
    required: ['amount_numeric', 'amount_words', 'date', 'payer', 'bank', 'cheque_number']
  }
} as const;

export const REGION_PROMPT =
  'This scanned page may contain ONE or SEVERAL separate bank cheques. Identify every distinct ' +
  'physical cheque and give a bounding box for each as fractions of the image size with the origin ' +
  'at the TOP-LEFT: x0,y0 is the top-left corner and x1,y1 the bottom-right, each between 0 and 1. ' +
  'Order cheques top-to-bottom then left-to-right. Exclude page edges, staples, and anything that is ' +
  'not a cheque. If a single cheque covers most of the page, return one box [0,0,1,1].';

export const REGION_TOOL = {
  name: 'cheque_regions',
  description: 'Return one bounding box per distinct cheque detected on the page.',
  input_schema: {
    type: 'object',
    properties: {
      regions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            x0: { type: 'number' },
            y0: { type: 'number' },
            x1: { type: 'number' },
            y1: { type: 'number' }
          },
          required: ['x0', 'y0', 'x1', 'y1']
        }
      }
    },
    required: ['regions']
  }
} as const;
