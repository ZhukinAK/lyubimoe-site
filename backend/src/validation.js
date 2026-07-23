import { assert } from "./errors.js";

const USERNAME_RE = /^[a-z0-9._-]{2,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export function loginInput(body) {
  const username = String(body?.username || "").trim().toLowerCase();
  const password = String(body?.password || "");
  assert(USERNAME_RE.test(username), 400, "invalid_username", "Некорректное имя пользователя.");
  assert(password.length >= 8 && password.length <= 200, 400, "invalid_password", "Некорректный пароль.");
  return { username, password };
}

export function memoryInput(body) {
  const text = String(body?.text || "").trim();
  const memoryDate = String(body?.memoryDate || "");
  const label = String(body?.label || "момент").trim();
  assert(text.length >= 1 && text.length <= 600, 400, "invalid_text", "Запись должна содержать от 1 до 600 символов.");
  assert(DATE_RE.test(memoryDate) && !Number.isNaN(Date.parse(`${memoryDate}T00:00:00Z`)), 400, "invalid_date", "Некорректная дата.");
  assert(label.length >= 1 && label.length <= 32, 400, "invalid_label", "Некорректная метка.");
  return { text, memoryDate, label };
}

export function uploadInput(body) {
  const caption = String(body?.caption || "").trim();
  const contentType = String(body?.contentType || "").toLowerCase();
  const size = Number(body?.size);
  assert(caption.length <= 80, 400, "invalid_caption", "Подпись слишком длинная.");
  assert(ALLOWED_IMAGE_TYPES.has(contentType), 400, "invalid_image_type", "Поддерживаются JPEG, PNG, WebP и GIF.");
  assert(Number.isInteger(size) && size > 0 && size <= 8 * 1024 * 1024, 400, "invalid_image_size", "Размер изображения не должен превышать 8 МБ.");
  return { caption, contentType, size };
}

export function entityId(value) {
  const id = String(value || "");
  assert(/^[0-9a-f-]{36}$/i.test(id), 400, "invalid_id", "Некорректный идентификатор.");
  return id;
}
