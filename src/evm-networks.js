// Reviewed against the provider/network documentation on 2026-08-31.
// A network existing here is NOT permission to invoice, sign, bridge or spend.
const EVM_NETWORKS=Object.freeze({
  base:Object.freeze({id:'base',name:'Base',chain_id:8453,chain_hex:'0x2105',testnet:false,alchemy_host:'base-mainnet.g.alchemy.com',explorer:'https://basescan.org',native_usdc:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',checkout_implementation:'existing_base_usdc'}),
  ethereum:Object.freeze({id:'ethereum',name:'Ethereum',chain_id:1,chain_hex:'0x1',testnet:false,alchemy_host:'eth-mainnet.g.alchemy.com',explorer:'https://etherscan.io',native_usdc:'0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',checkout_implementation:'not_enabled'}),
  robinhood:Object.freeze({id:'robinhood',name:'Robinhood Chain',chain_id:4663,chain_hex:'0x1237',testnet:false,alchemy_host:'robinhood-mainnet.g.alchemy.com',explorer:'https://robinhoodchain.blockscout.com',native_usdc:null,checkout_implementation:'not_enabled'}),
  'robinhood-testnet':Object.freeze({id:'robinhood-testnet',name:'Robinhood Chain Testnet',chain_id:46630,chain_hex:'0xb626',testnet:true,alchemy_host:'robinhood-testnet.g.alchemy.com',explorer:'https://explorer.testnet.chain.robinhood.com',native_usdc:null,checkout_implementation:'never_accept_testnet_payments'}),
});
function evmNetwork(id){
  if(typeof id!=='string'||!Object.hasOwn(EVM_NETWORKS,id))throw new Error('unsupported_network');
  return EVM_NETWORKS[id];
}
export {EVM_NETWORKS,evmNetwork};
