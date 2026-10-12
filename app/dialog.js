// A small modal text prompt that replaces window.prompt: styled, focus-trapped by <dialog>, and awaitable.
const dialog = document.getElementById("dialog");
const form = document.getElementById("dialogForm");
const title = document.getElementById("dialogTitle");
const text = document.getElementById("dialogText");
const input = document.getElementById("dialogInput");
const error = document.getElementById("dialogError");
const message = document.getElementById("dialogMessage");
const labelEl = document.getElementById("dialogLabel");
const okButton = document.getElementById("dialogOk");
const cancelButton = document.getElementById("dialogCancel");

/**
 * Resolves with the entered text, or null if the dialog was cancelled.
 * `validate` may return an error message to keep the dialog open.
 */
export function askText({ title: heading, label = "", value = "", type = "text", okText = "OK", validate } = {}) {
  return new Promise((resolve) => {
    title.textContent = heading;
    message.hidden = true;
    labelEl.hidden = false;
    text.textContent = label;
    input.type = type;
    input.value = value;
    error.hidden = true;
    okButton.textContent = okText;

    const finish = (result) => {
      form.removeEventListener("submit", onSubmit);
      cancelButton.removeEventListener("click", onCancel);
      dialog.removeEventListener("cancel", onCancel);
      if (dialog.open) dialog.close();
      resolve(result);
    };
    const onSubmit = (e) => {
      e.preventDefault();
      const problem = validate?.(input.value);
      if (problem) {
        error.textContent = problem;
        error.hidden = false;
        return;
      }
      finish(input.value);
    };
    const onCancel = (e) => {
      e?.preventDefault?.();
      finish(null);
    };
    form.addEventListener("submit", onSubmit);
    cancelButton.addEventListener("click", onCancel);
    dialog.addEventListener("cancel", onCancel);
    dialog.showModal();
    input.focus();
    input.select();
  });
}

/** A yes/no question. Resolves true if the user confirmed. */
export function askConfirm({ title: heading, message: body, okText = "OK" } = {}) {
  return new Promise((resolve) => {
    title.textContent = heading;
    message.textContent = body;
    message.hidden = false;
    labelEl.hidden = true;
    error.hidden = true;
    okButton.textContent = okText;

    const finish = (result) => {
      form.removeEventListener("submit", onSubmit);
      cancelButton.removeEventListener("click", onCancel);
      dialog.removeEventListener("cancel", onCancel);
      if (dialog.open) dialog.close();
      resolve(result);
    };
    const onSubmit = (e) => {
      e.preventDefault();
      finish(true);
    };
    const onCancel = (e) => {
      e?.preventDefault?.();
      finish(false);
    };
    form.addEventListener("submit", onSubmit);
    cancelButton.addEventListener("click", onCancel);
    dialog.addEventListener("cancel", onCancel);
    dialog.showModal();
    okButton.focus();
  });
}

const choiceDialog = document.getElementById("choiceDialog");
const choiceTitle = document.getElementById("choiceTitle");
const choiceMessage = document.getElementById("choiceMessage");
const choiceActions = document.getElementById("choiceActions");

/**
 * A question with several answers. `choices` is [{ key, label, primary?, danger? }]; resolves with the chosen key,
 * or null if the dialog was dismissed.
 */
export function askChoice({ title: heading, message: body, choices }) {
  return new Promise((resolve) => {
    choiceTitle.textContent = heading;
    choiceMessage.textContent = body;
    choiceActions.replaceChildren();
    let answered = false;
    const finish = (key) => {
      if (answered) return;
      answered = true;
      choiceDialog.removeEventListener("cancel", onCancel);
      if (choiceDialog.open) choiceDialog.close();
      resolve(key);
    };
    const onCancel = (e) => {
      e.preventDefault();
      finish(null);
    };
    for (const c of choices) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = c.primary ? "btn primary" : "btn";
      if (c.danger) b.classList.add("danger");
      b.textContent = c.label;
      b.addEventListener("click", () => finish(c.key));
      choiceActions.append(b);
    }
    choiceDialog.addEventListener("cancel", onCancel);
    choiceDialog.showModal();
    choiceActions.querySelector(".primary")?.focus();
  });
}
