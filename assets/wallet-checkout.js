// Self-hosted: no analytics or third-party script can read the invoice token.
const configElement = document.getElementById('wallet-checkout-config');
if (configElement) {
  const config = JSON.parse(configElement.textContent);
  const button = document.getElementById('wallet-pay');
  const status = document.getElementById('wallet-status');
  const resume = document.getElementById('wallet-resume');
  const storageKey='mag.pending-payment:'+config.intent_url;
  let pendingHash = null, sendOutcomeUnknown=false;
  try{const saved=sessionStorage.getItem(storageKey);if(/^0x[0-9a-f]{64}$/i.test(saved||''))pendingHash=saved;else if(saved==='unknown')sendOutcomeUnknown=true;}catch{}
  const persist=value=>{try{sessionStorage.setItem(storageKey,value);}catch{}};
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(path, {method, headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.access_token}, body:body ? JSON.stringify(body) : undefined, cache:'no-store', redirect:'error'});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Request could not be completed');
    return result;
  };
  const refreshStatus=async()=>{
    try{
      const result=await request(config.status_url);
      const paid=result.order?.payment_status==='verified'||result.subscription?.status==='active';
      if(paid){status.textContent='Payment verified. Your order or subscription is active. Open its workspace below for progress and delivery.';return;}
    }catch{}
    setTimeout(refreshStatus,30000);
  };
  const saveReceipt = async () => {
    if (!pendingHash) return;
    await request(config.receipt_url, 'POST', {tx_hash:pendingHash});
    status.textContent = 'Payment submitted. Waiting for independent Base finality checks. No second payment is needed. Transaction: '+pendingHash;
    resume.hidden = true;
    button.disabled = true;
    void refreshStatus();
  };
  if(pendingHash){button.disabled=true;resume.hidden=false;status.textContent='A payment was already sent. Retry saving its receipt, not the payment: '+pendingHash;}
  if(sendOutcomeUnknown){button.disabled=true;status.textContent='The previous wallet request has an unknown outcome. Check wallet activity before attempting any further payment; contact MAG if a transaction was sent without a saved receipt.';}
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const provider = window.ethereum;
      if (!provider?.request) throw new Error('Open this page in your wallet browser or enable a compatible browser wallet. No payment has been sent.');
      const {payment_request:p} = await request(config.intent_url, 'POST', {});
      const accounts = await provider.request({method:'eth_requestAccounts'});
      if (!/^0x[0-9a-f]{40}$/i.test(accounts?.[0] || '')) throw new Error('Choose a wallet account to continue');
      if ((await provider.request({method:'eth_chainId'})).toLowerCase() !== p.chainId) await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:p.chainId}]});
      if ((await provider.request({method:'eth_chainId'})).toLowerCase() !== p.chainId) throw new Error('Base must be selected before payment');
      const tx = {from:accounts[0],to:p.to,value:p.value,data:p.data,chainId:p.chainId};
      // A simulation catches an unsupported token call or insufficient balance.
      await provider.request({method:'eth_call',params:[tx,'latest']});
      status.textContent = 'Review the exact USDC amount and recipient in your wallet. MAG never receives your private key.';
      sendOutcomeUnknown=true;persist('unknown');
      try{pendingHash = await provider.request({method:'eth_sendTransaction',params:[tx]});}
      catch(error){if(Number(error.code)===4001){sendOutcomeUnknown=false;persist('rejected');}throw error;}
      if (!/^0x[0-9a-f]{64}$/i.test(pendingHash || '')) throw new Error('Wallet did not return a transaction receipt. Check your wallet before retrying.');
      sendOutcomeUnknown=false;persist(pendingHash);
      resume.hidden = false;
      status.textContent = 'Transaction sent: '+pendingHash+'. Saving its receipt…';
      await saveReceipt();
    } catch (error) {
      status.textContent = (pendingHash ? 'Do not pay again. Transaction: '+pendingHash+'. Use Retry receipt below. ' : sendOutcomeUnknown?'Do not pay again until you check wallet activity; the transfer outcome is unknown. ':'') + String(error.message || 'Payment interrupted');
      button.disabled = Boolean(pendingHash)||sendOutcomeUnknown;
    }
  });
  resume.addEventListener('click', async () => {try {await saveReceipt();} catch {status.textContent='Receipt could not be saved yet. Keep this transaction hash and retry: '+pendingHash;}});
}
