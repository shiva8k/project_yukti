// The extension uses the side panel. This remains harmless for direct popup testing.
document.addEventListener('DOMContentLoaded', () => {
  const result = document.getElementById('result');
  if (result) result.textContent = 'Open the YUKTI side panel from the extension toolbar to run a task.';
});
