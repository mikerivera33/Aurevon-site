export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  try {
    const report = req.body?.['csp-report'] || req.body || {};
    const fields = {
      blocked: report['blocked-uri'],
      directive: report['violated-directive'] || report['effective-directive'],
      doc: report['document-uri'],
      ref: report['referrer'],
      sample: report['script-sample'],
    };
    console.warn('[CSP Report]', JSON.stringify(fields));
  } catch (err) {
    console.warn('[CSP Report] parse failed:', err.message);
  }
  res.status(204).end();
}
