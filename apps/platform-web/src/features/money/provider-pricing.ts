export function formatProviderMoney(amountMinor: number, currency: string): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new Error("Invalid provider amount")
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(amountMinor / 100)
}

export function hostedCheckoutUrl(value:string|undefined):string|undefined {
  if(!value)return undefined
  try {
    const url=new URL(value)
    if(value.length<=2048 && url.protocol==="https:" && url.hostname==="rzp.io" && !url.port && !url.username && !url.password && !url.hash && url.pathname!=="/")return url.href
  }catch{ /* An invalid provider URL never becomes a customer link. */ }
  return undefined
}
