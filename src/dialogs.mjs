// The app-wide confirmation dialog. app.mjs and artist.mjs share one <dialog>, so this
// lives in its own module instead of being duplicated per screen.

let settle = null;

function answer(value) {
  const done = settle;
  settle = null;
  document.querySelector('#confirm-dialog')?.close();
  if (done) done(value);
}

export function askConfirm(title, message, okLabel = 'Delete') {
  return new Promise(resolve => {
    settle = resolve;
    document.querySelector('#confirm-title').textContent = title;
    document.querySelector('#confirm-message').textContent = message;
    document.querySelector('#confirm-ok').textContent = okLabel;
    document.querySelector('#confirm-dialog').showModal();
    document.querySelector('#confirm-cancel').focus();
  });
}

document.addEventListener('click', event => {
  if (event.target.closest('#confirm-ok')) answer(true);
  if (event.target.closest('#confirm-cancel')) answer(false);
});
document.addEventListener('cancel', event => {
  if (event.target?.id === 'confirm-dialog') {
    event.preventDefault();
    answer(false);
  }
}, true);
