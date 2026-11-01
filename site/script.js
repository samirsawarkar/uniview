/* UniView — Client-side interactions & purposeful animation. */
/* Follows Ponytail (full) principles: vanilla JS, standard platform APIs, zero dependencies. */

(function () {
  'use strict';

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Signal JS is active so progressive enhancement styles apply safely
  document.documentElement.classList.add('js-ready');

  // 1. Reading progress indicator
  const progress = document.querySelector('.scroll-progress');
  if (progress) {
    let tickingProgress = false;
    window.addEventListener('scroll', () => {
      if (!tickingProgress) {
        requestAnimationFrame(() => {
          const max = document.documentElement.scrollHeight - window.innerHeight;
          const ratio = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
          progress.style.transform = `scaleX(${ratio})`;
          tickingProgress = false;
        });
        tickingProgress = true;
      }
    }, { passive: true });
  }

  // 2. Navigation: Frosted background on scroll
  const nav = document.querySelector('.nav');
  if (nav) {
    const updateNavScroll = () => {
      if (window.scrollY > 24) {
        nav.classList.add('scrolled');
      } else {
        nav.classList.remove('scrolled');
      }
    };
    updateNavScroll();
    window.addEventListener('scroll', updateNavScroll, { passive: true });
  }

  // 3. Mobile Navigation Menu Toggle
  const menuBtn = document.querySelector('.menu-toggle');
  const navLinks = document.querySelector('.nav-links');
  if (menuBtn && navLinks) {
    const toggleMenu = (open) => {
      menuBtn.setAttribute('aria-expanded', String(open));
      navLinks.classList.toggle('open', open);
    };

    menuBtn.addEventListener('click', () => {
      const isOpen = menuBtn.getAttribute('aria-expanded') === 'true';
      toggleMenu(!isOpen);
    });

    navLinks.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => toggleMenu(false));
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') toggleMenu(false);
    });
  }

  // 4. Active nav link follows the section in view
  const sectionIds = ['connect', 'features', 'formats', 'agents', 'privacy', 'about'];
  const sections = sectionIds
    .map(id => document.getElementById(id))
    .filter(Boolean);

  if (sections.length > 0 && navLinks) {
    const navAnchors = Array.from(navLinks.querySelectorAll('a[href^="#"]'));
    const inView = new Set();
    const sectionObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) inView.add(entry.target.id);
        else inView.delete(entry.target.id);
      });
      // Nothing in view (the hero) means no link is current.
      const current = sectionIds.find(id => inView.has(id));
      navAnchors.forEach(a => a.classList.toggle('active', a.getAttribute('href') === `#${current}`));
    }, { threshold: 0.35, rootMargin: '-60px 0px -40% 0px' });

    sections.forEach(sec => sectionObserver.observe(sec));
  }

  // 5. Hero device image subtle scroll-linked depth
  const stageImg = document.querySelector('.product-stage > img');
  if (stageImg && !reducedMotion) {
    let tickingHero = false;
    window.addEventListener('scroll', () => {
      if (!tickingHero) {
        requestAnimationFrame(() => {
          const sy = window.scrollY;
          if (sy < 900) {
            /* ponytail: subtle parallax translate on device stage, capped at 900px scroll */
            stageImg.style.transform = `translate3d(0, ${sy * 0.07}px, 0)`;
          }
          tickingHero = false;
        });
        tickingHero = true;
      }
    }, { passive: true });
  }

  // 6. Connection demo (#connect) narrative loop
  const connectionDemo = document.querySelector('.connection-demo');
  if (connectionDemo) {
    if (reducedMotion) {
      connectionDemo.classList.remove('story-active');
    } else {
      const demoObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            connectionDemo.classList.add('story-active');
          } else {
            connectionDemo.classList.remove('story-active');
          }
        });
      }, { threshold: 0.25 });
      demoObserver.observe(connectionDemo);
    }
  }

  // 7. General Scroll Reveal for feature cards, format cards, privacy points
  if (!reducedMotion) {
    const revealElements = document.querySelectorAll(
      '.features article, .format-card, .privacy-points article, .closing'
    );
    if (revealElements.length > 0) {
      const revealObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            revealObserver.unobserve(entry.target);
          }
        });
      }, { threshold: 0.12 });

      revealElements.forEach(el => {
        el.classList.add('reveal');
        revealObserver.observe(el);
      });
    }
  }

  // 8. Primary Button Magnetic Feedback (fine pointer only)
  if (!reducedMotion && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    const primaryBtns = document.querySelectorAll('.button.primary');
    primaryBtns.forEach(btn => {
      btn.addEventListener('mousemove', (e) => {
        const rect = btn.getBoundingClientRect();
        const x = (e.clientX - rect.left - rect.width / 2) * 0.16;
        const y = (e.clientY - rect.top - rect.height / 2) * 0.16;
        /* ponytail: subtle cursor pull within +/-5px bound */
        btn.style.transform = `translate3d(${x}px, ${y}px, 0) scale(1.01)`;
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.transform = '';
      });
    });
  }

})();
