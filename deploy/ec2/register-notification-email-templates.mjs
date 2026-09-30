import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function notificationEmailTemplates() {
  const catalog = JSON.parse(readFileSync(new URL('./notification-email-templates.json', import.meta.url), 'utf8'));
  const templates = [];
  for (const [locale, content] of Object.entries(catalog.locales)) {
    const suffix = locale ? `-${locale}` : '';
    for (const eventClass of catalog.event_classes) {
      templates.push({ TemplateName: `notification-${eventClass}${suffix}`, TemplateContent: content.event });
    }
    templates.push({ TemplateName: `notification-digest${suffix}`, TemplateContent: content.digest });
  }
  return templates;
}

export function registerNotificationEmailTemplates(templates, runAws) {
  for (const template of templates) {
    let operation = 'update-email-template';
    try {
      runAws(['sesv2', 'get-email-template', '--template-name', template.TemplateName]);
    } catch (error) {
      if (!String(error.stderr ?? '').includes('NotFoundException')) throw new Error(`SES template lookup failed: ${template.TemplateName}`);
      operation = 'create-email-template';
    }
    runAws(['sesv2', operation, '--cli-input-json', JSON.stringify(template)]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] && !['--dry-run', '--apply'].includes(args[0]))) {
    console.error('usage: register-notification-email-templates.mjs [--dry-run|--apply]');
    process.exit(2);
  }
  const templates = notificationEmailTemplates();
  if (args[0] === '--apply') {
    try {
      const region = process.env.SES_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1';
      registerNotificationEmailTemplates(templates, (command) => execFileSync('aws', ['--region', region, ...command], { stdio: ['ignore', 'pipe', 'pipe'] }));
      console.log(`notification-templates-registered: ${templates.length}`);
    } catch {
      console.error('SES template registration failed; inspect account permissions and template configuration.');
      process.exit(1);
    }
  } else {
    console.log(JSON.stringify(templates, null, 2));
    console.log(`notification-templates-dry-run-ok: ${templates.length}; no AWS call made`);
  }
}
