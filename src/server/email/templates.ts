/**
 * Transactional email templates (SPEC §19): only DB fields (service, time, amounts, ref) and a cleaned
 * first name. Never problem_summary or any other free text; subjects are fixed.
 */

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** ≤ 40 characters, no URLs, no control characters. */
export function cleanFirstName(name: string | null | undefined): string {
  const first =
    (name ?? "")
      .toWellFormed()
      .replace(/https?:\/\/\S+|www\.\S+/gi, "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .split(/\s+/)[0] ?? "";
  return first.slice(0, 40) || "there";
}

type Base = { businessName: string; ref: string; serviceName: string; slotLabel: string; firstName: string };

function layout(title: string, body: string): string {
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#111;max-width:560px;margin:0 auto;padding:24px">
<p style="color:#0a5cff;font-weight:bold;margin:0">holdline</p><h1 style="font-size:20px">${escape(title)}</h1>${body}
<p style="color:#666;font-size:12px;margin-top:32px">Holdline is an independent hackathon project. Not affiliated with PayPal. PayPal sandbox only — no real money moves.</p>
</body></html>`;
}

export type RenderedEmail = { template: string; subject: string; html: string };

export function paymentLinkEmail(
  input: Base & { holdAmount: string; noShowFee: string; payUrl: string },
): RenderedEmail {
  const body = `<p>Hi ${escape(input.firstName)},</p>
<p>${escape(input.businessName)} is holding <b>${escape(input.serviceName)}</b> for you on <b>${escape(input.slotLabel)}</b> (booking ${escape(input.ref)}).</p>
<p>To secure the appointment, approve a PayPal hold of <b>${escape(input.holdAmount)}</b>. It is a hold, not a charge: it is charged only after the job. If nobody is home, a ${escape(input.noShowFee)} no-show fee applies; cancelling up to 24 hours before is free.</p>
<p><a href="${escape(input.payUrl)}" style="background:#0a5cff;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Approve the hold</a></p>`;
  return {
    template: "payment_link",
    subject: "Approve your appointment hold",
    html: layout("Approve your appointment hold", body),
  };
}

export function confirmedEmail(input: Base & { holdAmount: string; technicianFirstName: string }): RenderedEmail {
  const body = `<p>Hi ${escape(input.firstName)},</p>
<p>PayPal confirmed the ${escape(input.holdAmount)} hold. Your appointment is confirmed: <b>${escape(input.serviceName)}</b> on <b>${escape(input.slotLabel)}</b> with ${escape(input.technicianFirstName)} (booking ${escape(input.ref)}).</p>
<p>The hold is charged only after the job. Cancelling up to 24 hours before is free.</p>`;
  return {
    template: "confirmed",
    subject: "Your appointment is confirmed",
    html: layout("Your appointment is confirmed", body),
  };
}
