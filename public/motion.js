(() => {
  if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const targets = [...document.querySelectorAll('.section-top, .format-card, .catalog-shell, .application-intro, .form-panel, .price-card, .faq, .contact-layout')];
  if (!targets.length) return;
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    });
  // The catalog is much taller than a small mobile viewport. A high percentage
  // threshold could otherwise keep the entire section permanently invisible.
  }, { threshold: 0, rootMargin: '0px 0px 30px 0px' });
  targets.forEach(target => { target.classList.add('reveal-on-scroll'); observer.observe(target); });
  document.documentElement.classList.add('js-motion');
})();
