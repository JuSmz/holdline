/** The subset of PayPal Orders v2 / Payments v2 shapes Holdline reads. */

export type Money = { currency_code: string; value: string };

export type AuthorizationStatus = "CREATED" | "CAPTURED" | "DENIED" | "PARTIALLY_CAPTURED" | "VOIDED" | "PENDING";

export type Authorization = {
  id: string;
  status: AuthorizationStatus;
  status_details?: { reason?: string };
  amount: Money;
  invoice_id?: string;
  custom_id?: string;
  expiration_time?: string;
  create_time?: string;
  update_time?: string;
  supplementary_data?: { related_ids?: { order_id?: string } };
  links?: { href: string; rel: string; method?: string }[];
};

export type CaptureStatus = "COMPLETED" | "DECLINED" | "PARTIALLY_REFUNDED" | "PENDING" | "REFUNDED" | "FAILED";

export type Capture = {
  id: string;
  status: CaptureStatus;
  status_details?: { reason?: string };
  amount: Money;
  final_capture?: boolean;
  invoice_id?: string;
  create_time?: string;
};

export type OrderStatus = "CREATED" | "SAVED" | "APPROVED" | "VOIDED" | "COMPLETED" | "PAYER_ACTION_REQUIRED";

export type Order = {
  id: string;
  status: OrderStatus;
  intent: "CAPTURE" | "AUTHORIZE";
  payer?: { payer_id?: string; address?: { country_code?: string } };
  purchase_units?: {
    reference_id?: string;
    custom_id?: string;
    invoice_id?: string;
    amount: Money;
    payee?: { email_address?: string; merchant_id?: string };
    payments?: { authorizations?: Authorization[]; captures?: Capture[] };
  }[];
  links?: { href: string; rel: string; method?: string }[];
};
