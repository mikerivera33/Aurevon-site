/**
 * merch-patch.js — Auto-loaded on merch page.
 * Handles broken product images, Snipcart-not-wired checkout guard,
 * and honest "opening soon" copy while the public key is still a placeholder.
 */
(function () {
  'use strict';

  function patchBrokenImages() {
    var imgs = document.querySelectorAll('.product-img img, [data-product-img]');
    imgs.forEach(function (img) {
      if (img.complete && img.naturalWidth === 0) {
        hideBrokenImg(img);
      } else {
        img.addEventListener('error', function () {
          hideBrokenImg(this);
        });
      }
    });
  }

  function hideBrokenImg(img) {
    img.style.display = 'none';
    var wrap = img.parentElement;
    if (wrap && !wrap.classList.contains('product-placeholder')) {
      wrap.classList.add('product-placeholder');
    }
  }

  function honestOpeningSoonCopy() {
    var badge = document.querySelector('.coming-soon-badge');
    if (badge) {
      var dot = badge.querySelector('.dot');
      badge.textContent = '';
      if (dot) badge.appendChild(dot);
      badge.appendChild(document.createTextNode(' Opening Soon'));
    }
    var desc = document.querySelector('.hero-desc');
    if (desc && /now live/i.test(desc.textContent || '')) {
      desc.textContent = 'First collection dropping Summer 2026. Premium apparel, accessories, and collector items. Built for the culture.';
    }
    document.querySelectorAll('.tag-cs').forEach(function (el) {
      if (/now live/i.test(el.textContent || '')) el.textContent = 'Opening Soon';
    });
    var og = document.querySelector('meta[property="og:description"]');
    if (og) {
      og.setAttribute('content', (og.getAttribute('content') || '').replace(/First collection now live\./g, 'First collection dropping soon.'));
    }
    var md = document.querySelector('meta[name="description"]');
    if (md) {
      md.setAttribute('content', (md.getAttribute('content') || '').replace(/First collection now live\./g, 'First collection dropping soon.'));
    }
  }

  function guardCartButtons() {
    var key = '';
    var snip = document.getElementById('snipcart');
    if (snip) key = snip.getAttribute('data-api-key') || '';
    document.querySelectorAll('script[data-api-key]').forEach(function (s) {
      key = s.getAttribute('data-api-key') || key;
    });
    var isPending = !key || key === 'YOUR_SNIPCART_PUBLIC_API_KEY' || key === 'SNIPCART_KEY_PENDING_SETUP' || /PENDING|YOUR_/i.test(key);
    if (!isPending) return;

    honestOpeningSoonCopy();

    document.querySelectorAll('[data-item-id], .snipcart-add-item, .product-buy-btn').forEach(function (btn) {
      btn.setAttribute('disabled', 'disabled');
      btn.style.opacity = '0.5';
      btn.style.cursor = 'not-allowed';
      btn.title = 'Checkout is not yet live.';
    });
    if (!document.getElementById('merch-setup-banner') && !document.getElementById('store-soon-banner')) {
      var banner = document.createElement('div');
      banner.id = 'merch-setup-banner';
      banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#1a1a2e;border-top:2px solid #3B82F6;color:#fff;text-align:center;padding:10px 16px;font-size:14px;z-index:9999;';
      banner.innerHTML = '\u26a0\ufe0f <strong>The Aurevon store is opening soon \u2014 checkout is not yet live.</strong> Questions? <a href="mailto:mike@aurevonvc.com" style="color:#3B82F6">mike@aurevonvc.com</a>';
      document.body.appendChild(banner);
    }
  }

  function run() {
    patchBrokenImages();
    guardCartButtons();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
