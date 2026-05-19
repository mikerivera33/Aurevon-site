/**
 * merch-patch.js — Auto-loaded on merch page.
 * Handles broken product images by falling back to branded SVG placeholder.
 * Also initialises Snipcart cart count badge.
 */
(function () {
  'use strict';

  // ---- Broken image fallback ----
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

  // ---- Cart button guard — disable if Snipcart key not set ----
  function guardCartButtons() {
    var scripts = document.querySelectorAll('script[data-api-key]');
    var key = '';
    scripts.forEach(function (s) { key = s.getAttribute('data-api-key') || ''; });
    var isPending = !key || key === 'YOUR_SNIPCART_PUBLIC_API_KEY' || key === 'SNIPCART_KEY_PENDING_SETUP';
    if (isPending) {
      document.querySelectorAll('[data-item-id], .snipcart-add-item').forEach(function (btn) {
        btn.setAttribute('disabled', 'disabled');
        btn.style.opacity = '0.5';
        btn.style.cursor = 'not-allowed';
        btn.title = 'Store setup in progress — check back soon!';
      });
      // Show a banner
      var banner = document.createElement('div');
      banner.id = 'merch-setup-banner';
      banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#1a1a2e;border-top:2px solid #3B82F6;color:#fff;text-align:center;padding:10px 16px;font-size:14px;z-index:9999;';
      banner.innerHTML = '\u26a0\ufe0f <strong>Store checkout is being configured.</strong> Browse now \u2014 purchasing will be live very soon! Questions? <a href="mailto:hello@aurevonvc.com" style="color:#3B82F6">hello@aurevonvc.com</a>';
      document.body.appendChild(banner);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      patchBrokenImages();
      guardCartButtons();
    });
  } else {
    patchBrokenImages();
    guardCartButtons();
  }
})();
