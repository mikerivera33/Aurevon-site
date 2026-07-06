/**
 * Lightweight alert sink for the payment / mint pipeline.
 *
 * The audit found that every failure — mint failure, dropped mint row, cron
 * error tallies — was a console.error into runtime logs nobody watches. This
 * posts a short message to ALERT_WEBHOOK_URL (Slack-compatible incoming webhook,
 * or any endpoint that accepts a JSON body) so failures surface proactively.
 *
 * Contract:
 *   - No-op (never throws) when ALERT_WEBHOOK_URL is unset — safe to call anywhere.
 *   - Never blocks a caller into failure: send errors are swallowed + logged.
 *   - PRIVACY: pass only IDs / event types / counts in `detail`. Do NOT pass
 *     customer email or other PII — this leaves our infrastructure for a webhook.
 *
 * @param {string} event  short machine-ish event name, e.g. 'stripe.mint_failed'
 * @param {object} [detail] small bag of IDs/counts (no PII)
 * @returns {Promise<{ok: boolean, skipped?: boolean, error?: string}>}
 */
export async function sendAlert(event, detail = {}) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return { ok: false, skipped: true };

  const summary = Object.entries(detail)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  const text = `⚠️ [Aurevon] ${event}${summary ? ` — ${summary}` : ''}`;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `text` satisfies Slack/Discord incoming webhooks; `event`/`detail`/`ts`
      // give structured consumers the same data.
      body: JSON.stringify({ text, event, detail, ts: new Date().toISOString() }),
    });
    return { ok: true };
  } catch (err) {
    console.error(`[alert] send failed for "${event}": ${err.message}`);
    return { ok: false, error: err.message };
  }
}
