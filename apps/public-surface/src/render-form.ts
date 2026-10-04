import type { HostedFormDefinition } from "@alterx/contracts";

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
export function renderPublicForm(definition: HostedFormDefinition, siteKey: string, context: string, nonce: string): string {
  const fields = definition.fields.map(field => {
    const attributes = `data-form-field data-type="${field.type}" name="${escape(field.name)}" id="${escape(field.name)}"${field.required ? " required" : ""}`;
    let input: string;
    if (field.type === "textarea") input = `<textarea ${attributes} maxlength="${field.maxLength}"></textarea>`;
    else if (field.type === "select") input = `<select ${attributes}><option value="">Choose…</option>${field.options.map(option => `<option value="${escape(option)}">${escape(option)}</option>`).join("")}</select>`;
    else input = `<input ${attributes} type="${field.type}"${field.type === "text" ? ` maxlength="${field.maxLength}"` : ""}${field.type === "number" ? ` step="any"${field.min === undefined ? "" : ` min="${field.min}"`}${field.max === undefined ? "" : ` max="${field.max}"`}` : ""}>`;
    return `<label for="${escape(field.name)}">${escape(field.label)}${input}</label>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(definition.title)}</title>
<style>body{font:16px system-ui,sans-serif;color:#172321;background:#f6f8f7;margin:0;padding:24px}main{max-width:600px;margin:40px auto;background:white;padding:32px;border-radius:16px}label{display:block;margin:20px 0}input,textarea,select,button{box-sizing:border-box;width:100%;font:inherit;padding:12px;margin-top:8px;border:1px solid #bdc9c4;border-radius:8px}button{background:#185c45;color:white;cursor:pointer}button:disabled{opacity:.6}#status{min-height:24px}</style></head><body><main><h1>${escape(definition.title)}</h1><p>${escape(definition.description ?? "")}</p>
<form id="public-form">${fields}<div class="cf-turnstile" data-sitekey="${escape(siteKey)}" data-action="public_form" data-cdata="${escape(context)}"></div><button type="submit">Submit</button><p id="status" role="status" aria-live="polite"></p></form></main>
<script nonce="${escape(nonce)}" src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<script nonce="${escape(nonce)}">const form=document.getElementById('public-form'),status=document.getElementById('status');const submissionId=crypto.randomUUID();form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;status.textContent='Submitting…';try{const values={};for(const field of form.querySelectorAll('[data-form-field]')){if(field.value==='')continue;values[field.name]=field.dataset.type==='number'?Number(field.value):field.value;}const response=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({submissionId,values,turnstileResponse:new FormData(form).get('cf-turnstile-response')||''})});if(!response.ok)throw new Error(response.status===429?'Please try again later.':'Submission failed. Complete verification and retry.');status.textContent='Submission received.';form.reset();}catch(error){status.textContent=error.message;button.disabled=false;if(window.turnstile)window.turnstile.reset();}});</script></body></html>`;
}
