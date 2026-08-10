// Socket fleet — operator note, the in-page instruction widget.
//
// A REPEATABLE widget: any browser driver that needs the operator to do
// something renders one of these instead of printing to a terminal nobody is
// looking at. The operator is watching the browser window the agent opened —
// that is where the instruction belongs. `challenge-screen.js` is the fixed
// single-purpose ancestor of this; this one takes its content from the
// driver, so one widget serves sign-in, team switching, a role refusal, and
// a success notice.
//
// Contract: the driver calls it with a payload object, so every note across
// the fleet looks and behaves the same:
//   { kicker, title, body, steps: [string], tone: 'wait'|'do'|'stop'|'done' }
//
// The SHIELD literal is generated: scripts/repo/gen/playwright-banner.mts
// inlines the brand shield here, in agent-banner.js, and in
// challenge-screen.js from one composition.
// A bare function EXPRESSION on purpose, unlike the self-calling siblings in
// this dir: showOperatorNote reads this file as text and evaluates
// `(<source>)(<payload>)`, so the module's value has to be the function the
// driver calls with its payload. An IIFE here would run with no payload.
// oxlint-disable-next-line no-unused-expressions -- function-valued asset
payload => {
  'use strict'
  if (window.top !== window) {
    return
  }
  const MARK = 'data-socket-operator-note'
  const SHIELD = `<svg xmlns="http://www.w3.org/2000/svg" aria-label="Socket agent browser" viewBox="-6.527 2.221 32.279 32.279"><defs><linearGradient id="a" x1="0" x2="1" y1="0" y2="0"><stop offset="0%" stop-color="#f0a"/><stop offset="100%" stop-color="#8c50ff"/></linearGradient></defs><path fill="url(#a)" d="M18.44 8.84c.46.16.76.6.76 1.1-.04 3.58.23 8.63-.38 10.88-1.04 4.5-4.42 8.4-8.8 10.1a1.2 1.2 0 0 1-.84 0C4.52 29.15.92 24.73.18 19.8c-.06-.31-.1-.67-.13-.98-.04-.2-.05-1.14-.05-5.17V9.91a1.15 1.15 0 0 1 .76-1.07c2.8-1.02 5.38-1.93 8.2-2.96l.24-.1q.38-.12.77 0l2.24.81z" data-socket-layer="shield"/><path data-socket-layer="bolt" fill="#ffffff" d="M9.886 9.538c.192-.314.675-.178.675.19v5.85c0 .251.204.455.456.455h2.736c.285 0 .46.312.311.555l-4.909 8.038c-.192.314-.675.179-.675-.19v-5.849a.456.456 0 0 0-.456-.456H5.288a.365.365 0 0 1-.311-.554z"/></svg>`
  // Tone drives the accent only — never the layout, so notes stay uniform.
  const TONES = {
    do: '#8c50ff',
    done: '#22c55e',
    stop: '#f43f5e',
    wait: '#8c50ff',
  }
  const note = Object(payload)
  const accent = TONES[note.tone] || TONES.do
  const esc = s =>
    String(s == null ? '' : s).replace(
      /[&<>"']/g,
      c =>
        ({
          '"': '&quot;',
          '&': '&amp;',
          "'": '&#39;',
          '<': '&lt;',
          '>': '&gt;',
        })[c],
    )
  const remove = () => {
    const prior = document.querySelector('[' + MARK + ']')
    if (prior) {
      prior.remove()
    }
  }
  const insert = () => {
    if (!document.body) {
      return
    }
    // Replace rather than dedupe: a driver advancing to its next step wants
    // THIS note to supersede the last one, not to be dropped as a duplicate.
    remove()
    const host = document.createElement('div')
    host.setAttribute(MARK, '')
    // A closed shadow root so page CSS cannot restyle the note and the note's
    // CSS cannot leak into the page.
    const root = host.attachShadow({ mode: 'closed' })
    const steps = Array.isArray(note.steps) ? note.steps : []
    root.innerHTML =
      '<style>' +
      // BOTTOM-LEFT, and pointer-transparent except the card itself. The note
      // exists to ask the operator to click something, so it must never sit on
      // top of what it is asking for: a site's account/team switcher and its
      // primary actions live along the TOP of the page, and Apple's team
      // switcher — the exact control one of these notes points at — is at the
      // top RIGHT. A note anchored there covers its own instruction.
      ':host{position:fixed;bottom:18px;left:18px;z-index:2147483646;pointer-events:none}' +
      // A dark, slightly purple card — the Socket note surface.
      '.card{width:22rem;max-width:calc(100vw - 36px);pointer-events:auto;' +
      'background:linear-gradient(180deg,rgba(23,18,38,.97),rgba(15,12,26,.97));' +
      '-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);' +
      'border:1px solid rgba(140,80,255,.28);border-left:3px solid ' +
      accent +
      ';border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.55);' +
      'padding:16px 18px 14px;' +
      'font:400 13px/1.55 system-ui,-apple-system,sans-serif;color:#c7c7d1;' +
      'animation:sk-note-in .45s cubic-bezier(.2,.8,.2,1) both}' +
      '.head{display:flex;align-items:center;gap:9px;margin-bottom:8px}' +
      '.head svg{width:19px;height:19px;flex:none}' +
      '.kicker{font-size:11px;font-weight:600;letter-spacing:.09em;' +
      'text-transform:uppercase;color:' +
      accent +
      '}' +
      '.title{margin:0 0 6px;font-size:15px;font-weight:600;letter-spacing:-.01em;' +
      'color:#fafafa;text-wrap:pretty}' +
      '.body{margin:0;text-wrap:pretty}' +
      'ol{margin:10px 0 0;padding-left:1.15em;display:flex;flex-direction:column;gap:5px}' +
      'li{padding-left:2px}' +
      'li::marker{color:' +
      accent +
      ';font-weight:600}' +
      '.x{position:absolute;top:10px;right:12px;border:0;background:none;cursor:pointer;' +
      'color:#6b6b7b;font-size:15px;line-height:1;padding:2px}' +
      '.x:hover{color:#c7c7d1}' +
      // Rises from below, matching the bottom anchor.
      '@keyframes sk-note-in{from{opacity:0;transform:translateY(8px) scale(.98)}' +
      'to{opacity:1;transform:none}}' +
      '@media (prefers-reduced-motion:reduce){.card{animation:none}}' +
      '</style>' +
      '<div class="card" role="status" aria-live="polite" style="position:relative">' +
      '<button class="x" type="button" aria-label="Hide this note">&#10005;</button>' +
      '<div class="head">' +
      SHIELD +
      '<span class="kicker">' +
      esc(note.kicker || 'Socket agent') +
      '</span></div>' +
      (note.title ? '<h2 class="title">' + esc(note.title) + '</h2>' : '') +
      (note.body ? '<p class="body">' + esc(note.body) + '</p>' : '') +
      (steps.length
        ? '<ol>' + steps.map(s => '<li>' + esc(s) + '</li>').join('') + '</ol>'
        : '') +
      '</div>'
    root.querySelector('.x').addEventListener('click', () => host.remove())
    document.body.appendChild(host)
  }
  if (document.body) {
    insert()
  }
  document.addEventListener('DOMContentLoaded', insert, { once: true })
}
