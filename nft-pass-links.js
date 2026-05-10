// nft-pass-links.js
// Injects View Animated Pass buttons into each NFT card on aurevon-nft.html
(function(){
  var passMap=[
    {keyword:'OBSIDIAN',file:'nfts/obsidian.html',label:'View OBSIDIAN Pass'},
    {keyword:'EMBER',file:'nfts/ember.html',label:'View EMBER Pass'},
    {keyword:'INSIDER',file:'nfts/insider.html',label:'View INSIDER Pass'},
    {keyword:'CHROME',file:'nfts/chrome.html',label:'View CHROME Pass'},
    {keyword:'GENESIS',file:'nfts/genesis.html',label:'View GENESIS Pass'}
  ];
  function injectButtons(){
    document.querySelectorAll('.nft-card').forEach(function(card){
      if(card.querySelector('.nft-view-pass-btn'))return;
      var nameEl=card.querySelector('.nft-name');
      var cardText=nameEl?nameEl.textContent.toUpperCase():'';
      passMap.forEach(function(p){
        if(cardText.indexOf(p.keyword)!==-1){
          var infoEl=card.querySelector('.nft-info');
          if(!infoEl)return;
          var btn=document.createElement('a');
          btn.href=p.file;
          btn.target='_blank';
          btn.rel='noopener';
          btn.className='nft-view-pass-btn';
          btn.textContent=p.label;
          btn.style.cssText='display:inline-block;margin-top:10px;padding:8px 16px;background:linear-gradient(135deg,rgba(30,58,138,0.7),rgba(59,130,246,0.5));color:#e0f0ff;font-size:0.75rem;letter-spacing:0.08em;text-decoration:none;border-radius:8px;border:1px solid rgba(100,180,255,0.3);font-family:inherit;cursor:pointer;';
          infoEl.appendChild(btn);
        }
      });
    });
  }
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',injectButtons);}else{injectButtons();}
})();
