const esc = v => String(v ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
function walletCheckoutMarkup({accessToken,intentUrl,receiptUrl,amount}) {
  const statusUrl=intentUrl.startsWith("/api/subscriptions/")?intentUrl.split("/invoices/")[0]:intentUrl.replace(/\/payment-intent$/,"");
  const config=JSON.stringify({access_token:accessToken,intent_url:intentUrl,receipt_url:receiptUrl,status_url:statusUrl}).replace(/</g,"\\u003c");
  return `<section class="pay"><h2>Wallet checkout</h2><p>The recipient, Base network and exact ${esc(amount)} USDC amount are filled in automatically. Your wallet asks you to approve the transfer. No token allowance or recurring spending permission is requested.</p><button id="wallet-pay" type="button">Pay ${esc(amount)} USDC with wallet</button><button id="wallet-resume" type="button" hidden>Retry receipt — do not pay again</button><p id="wallet-status" role="status" aria-live="polite">Keep this page open until the receipt is saved. You control the signing key.</p><script type="application/json" id="wallet-checkout-config">${config}</script><script src="/wallet-checkout.js" defer></script></section>`;
}
export { walletCheckoutMarkup };
