// Approve / feedback widget shared by the idea review pages.
//
// Every element with class "idea" and a data-id gets three choice buttons
// (Yes / Maybe / No) and a feedback box. Choices and text are kept in
// localStorage under the page's data-page key, so a reload keeps them.
// The bar at the bottom builds one plain-text summary of every answer for
// pasting back into the chat ("Copy feedback"), or clears everything.
(function () {
  const pageKey = 'ideas:' + (document.body.dataset.page || location.pathname);
  let store = {};
  try {
    store = JSON.parse(localStorage.getItem(pageKey) || '{}') || {};
  } catch {
    store = {};
  }
  function save() {
    try {
      localStorage.setItem(pageKey, JSON.stringify(store));
    } catch {
      /* private mode: answers live for this page view only */
    }
  }

  let count = null; // the bottom bar's counter, built after the cards

  // Button labels: data-labels="Keep|Maybe|Remove" on <body> overrides the defaults.
  const labels = (document.body.dataset.labels || 'Yes, build it|Maybe|No').split('|');
  const CHOICES = [
    ['yes', labels[0] || 'Yes'],
    ['maybe', labels[1] || 'Maybe'],
    ['no', labels[2] || 'No'],
  ];

  const cards = [...document.querySelectorAll('.idea[data-id]')];
  for (const card of cards) {
    const id = card.dataset.id;
    const title = (card.querySelector('h2') || {}).textContent || id;
    const rec = (store[id] = store[id] || { choice: '', note: '' });

    const fb = document.createElement('div');
    fb.className = 'fb';
    const choices = document.createElement('div');
    choices.className = 'choices';
    const btns = {};
    for (const [val, label] of CHOICES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => {
        rec.choice = rec.choice === val ? '' : val;
        paint();
        save();
      });
      btns[val] = b;
      choices.appendChild(b);
    }
    const ta = document.createElement('textarea');
    ta.placeholder = 'Feedback, tweaks, what would make it fun...';
    ta.value = rec.note || '';
    ta.addEventListener('input', () => {
      rec.note = ta.value;
      save();
      updateCount();
    });
    fb.appendChild(choices);
    fb.appendChild(ta);
    card.appendChild(fb);

    function paint() {
      card.classList.remove('state-yes', 'state-maybe', 'state-no');
      for (const [val] of CHOICES) btns[val].classList.toggle('on-' + val, rec.choice === val);
      if (rec.choice) card.classList.add('state-' + rec.choice);
      updateCount();
    }
    card._fbTitle = title.replace(/^\s*\d+\s*/, '').trim();
    paint();
  }

  // Bottom bar.
  const bar = document.createElement('div');
  bar.className = 'fb-bar';
  count = document.createElement('div');
  count.className = 'count';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy feedback for Claude';
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'secondary';
  clear.textContent = 'Clear answers';
  bar.append(count, copy, clear);
  document.body.appendChild(bar);

  function updateCount() {
    if (!count) return; // the bar is built after the cards
    let yes = 0;
    let maybe = 0;
    let no = 0;
    let notes = 0;
    for (const c of cards) {
      const r = store[c.dataset.id];
      if (r.choice === 'yes') yes++;
      else if (r.choice === 'maybe') maybe++;
      else if (r.choice === 'no') no++;
      if (r.note && r.note.trim()) notes++;
    }
    const word = (i) => (labels[i] || '').split(/[ ,]/)[0].toLowerCase();
    count.textContent = `${cards.length} ideas: ${yes} ${word(0)}, ${maybe} ${word(1)}, ${no} ${word(2)}, ${notes} with notes`;
  }

  function summary() {
    const lines = [`Feedback on ${document.title}`, ''];
    for (const c of cards) {
      const r = store[c.dataset.id];
      if (!r.choice && !(r.note && r.note.trim())) continue;
      lines.push(`- ${c._fbTitle} [${c.dataset.id}]: ${r.choice ? r.choice.toUpperCase() : 'no choice'}`);
      if (r.note && r.note.trim()) lines.push(`  note: ${r.note.trim().replace(/\n+/g, ' / ')}`);
    }
    if (lines.length === 2) lines.push('(no answers yet)');
    return lines.join('\n');
  }

  function toast(text) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1600);
  }

  copy.addEventListener('click', async () => {
    const text = summary();
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      copied = false;
    }
    // Always show it too, so it can be selected by hand (iPad, file:// pages).
    const out = document.createElement('div');
    out.className = 'fb-out';
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.readOnly = true;
    const row = document.createElement('div');
    row.className = 'row';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    close.addEventListener('click', () => out.remove());
    row.appendChild(close);
    out.append(ta, row);
    document.body.appendChild(out);
    ta.focus();
    ta.select();
    toast(copied ? 'Copied to the clipboard' : 'Select the text and copy it');
  });

  clear.addEventListener('click', () => {
    if (!confirm('Clear every answer and note on this page?')) return;
    for (const c of cards) store[c.dataset.id] = { choice: '', note: '' };
    save();
    location.reload();
  });

  updateCount();
})();
