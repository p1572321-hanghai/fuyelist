(() => {
  const controls = document.querySelector('.controls');
  const input = document.querySelector('#search');
  const kind = document.querySelector('#kind');
  const cards = [...document.querySelectorAll('.project')];
  const buttons = [...document.querySelectorAll('[data-filter]')];
  let category = '';
  function render() {
    const query = input.value.trim().toLocaleLowerCase();
    let count = 0;
    for (const card of cards) {
      const visible = (!category || card.dataset.category === category) &&
        (!kind.value || card.dataset.kind === kind.value) &&
        (!query || card.dataset.search.toLocaleLowerCase().includes(query));
      card.hidden = !visible;
      if (visible) count++;
    }
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.filter === category));
    document.querySelector('#count').textContent = '显示 ' + count + ' / ' + cards.length + ' 个项目';
    document.querySelector('#empty').hidden = count !== 0;
  }
  controls.hidden = false;
  input.addEventListener('input', render);
  kind.addEventListener('change', render);
  for (const button of buttons) button.addEventListener('click', () => { category = button.dataset.filter; render(); });
  document.querySelector('#reset').addEventListener('click', () => { category = ''; input.value = ''; kind.value = ''; render(); input.focus(); });
})();
