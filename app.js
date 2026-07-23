const storageKeys = {
  played: "twoplace.played",
  links: "twoplace.links"
};

const requestTimeoutMs = 30000;
const signedUrlTtlSeconds = 3600;
const imagePlaceholder =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3Crect width='1' height='1' fill='%23f8fbff'/%3E%3C/svg%3E";
const imageUrlCache = new Map();

let sharedState = {
  user: null,
  roomId: null,
  initialized: false,
  galleryReady: false,
  memoriesReady: false,
  pendingMemories: [],
  memoriesCache: [],
  memoryCalendarMonth: null,
  selectedMemoryDate: null,
  pollTimer: null,
  activeRoute: "home"
};

function setStatus(selector, message) {
  const status = document.querySelector(selector);
  if (status) {
    status.textContent = message;
  }
}

function setSyncStatus(message) {
  setStatus("#sync-status", message);
}

function setGalleryStatus(message) {
  setStatus("#gallery-status", message);
}

function withTimeout(promise, message = "Запрос занял слишком много времени.", timeoutMs = requestTimeoutMs) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

async function retryOnce(task) {
  try {
    return await task();
  } catch (error) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    return task().catch(() => {
      throw error;
    });
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(new Error("Не получилось прочитать картинку.")));
    reader.readAsDataURL(blob);
  });
}

const words = [
  { word: "объятие", hint: "То, чего особенно не хватает на расстоянии" },
  { word: "письмо", hint: "Можно отправить даже без конверта" },
  { word: "созвон", hint: "Вечерний ритуал, который спасает день" },
  { word: "мандарин", hint: "Сладкий зимний запах" },
  { word: "пикник", hint: "Идея для будущей встречи" },
  { word: "комета", hint: "Что-то редкое и красивое" }
];

const alphabet = "абвгдеёжзийклмнопрстуфхцчшщъыьэюя".split("");

let hangman = {
  word: "",
  hint: "",
  author: "Набор",
  guesser: "Вы",
  guessed: new Set(),
  mistakes: 0,
  complete: false
};

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function createId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayKey() {
  return toDateKey(new Date());
}

function dateFromKey(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatDateKey(dateKey) {
  return dateFromKey(dateKey).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long"
  });
}

function formatMonthTitle(date) {
  return date.toLocaleDateString("ru-RU", {
    month: "long",
    year: "numeric"
  });
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function getMemoryDate(item) {
  return item.memory_date || toDateKey(new Date(item.created_at));
}

function getApiConfig() {
  const config = window.LYUBIMOE_API || {};
  return {
    baseUrl: (config.baseUrl || "").replace(/\/$/, ""),
    roomSlug: (config.roomSlug || "preview").trim(),
    pollIntervalMs: Number(config.pollIntervalMs) || 15000
  };
}

class ApiRequestError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function apiRequest(path, options = {}) {
  const { baseUrl } = getApiConfig();
  if (!baseUrl) throw new ApiRequestError("API не настроен.", 0, "api_not_configured");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || requestTimeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method || "GET",
      credentials: "include",
      cache: "no-store",
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.version ? { "if-match": String(options.version) } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) {
      const apiError = payload.error || {};
      throw new ApiRequestError(apiError.message || "Не получилось выполнить запрос.", response.status, apiError.code);
    }
    return payload;
  } catch (error) {
    if (error.name === "AbortError") throw new ApiRequestError("Сервер долго не отвечает.", 0, "timeout");
    if (error instanceof ApiRequestError) throw error;
    throw new ApiRequestError("Нет соединения с сервером.", 0, "network_error");
  } finally {
    clearTimeout(timeout);
  }
}

function handleSessionError(error) {
  if (error.status !== 401) return false;
  sharedState.user = null;
  sharedState.roomId = null;
  document.body.classList.add("locked");
  document.body.classList.remove("unlocked");
  setStatus("#auth-error", "Сессия истекла. Войдите снова.");
  stopPolling();
  return true;
}

function unlockRoom() {
  document.body.classList.remove("locked");
  document.body.classList.add("unlocked");
}

function initAccessGate() {
  const form = document.querySelector("#auth-form");
  const usernameInput = document.querySelector("#auth-username");
  const passwordInput = document.querySelector("#auth-password");
  const submit = form.querySelector("button");
  const error = document.querySelector("#auth-error");

  if (!getApiConfig().baseUrl) {
    error.textContent = "API пока не настроен.";
    submit.disabled = true;
    return;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    submit.disabled = true;

    try {
      const data = await apiRequest("/auth/login", {
        method: "POST",
        body: { username: usernameInput.value.trim(), password: passwordInput.value }
      });
      sharedState.user = data.user;
      sharedState.roomId = data.room.id;
      passwordInput.value = "";
      unlockRoom();
      startSharedRoom();
    } catch (errorValue) {
      error.textContent = errorValue.message || "Не получилось войти.";
      passwordInput.select();
    } finally {
      submit.disabled = false;
    }
  });

  apiRequest("/auth/me").then((data) => {
      sharedState.user = data.user;
      sharedState.roomId = data.room.id;
      unlockRoom();
      startSharedRoom();
    }).catch(() => {});
}

function startSharedRoom() {
  if (sharedState.initialized || !sharedState.roomId) return;
  sharedState.initialized = true;
  setSyncStatus("Общая комната подключена.");
  initGallery();
  initMemories();
  startPolling();
}

function setRoute(route) {
  const nextRoute = route || "home";
  sharedState.activeRoute = nextRoute;
  document.querySelectorAll("[data-view]").forEach((view) => {
    view.classList.toggle("active", view.id === nextRoute);
  });
  document.querySelectorAll("[data-route]").forEach((link) => {
    link.classList.toggle("active", link.dataset.route === nextRoute);
  });
  refreshActiveRoute();
}

function initRouter() {
  const apply = () => setRoute(location.hash.replace("#", "") || "home");
  window.addEventListener("hashchange", apply);
  apply();
}

function pickWord() {
  const item = words[Math.floor(Math.random() * words.length)];
  hangman = {
    word: item.word,
    hint: item.hint,
    author: "Набор",
    guesser: "вы вдвоём",
    guessed: new Set(),
    mistakes: 0,
    complete: false
  };
  renderHangman();
}

function startCustomRound(author, word, hint) {
  const cleanWord = word.toLowerCase().replace(/[^а-яё]/g, "");
  if (!cleanWord || !hint.trim()) return false;

  hangman = {
    word: cleanWord,
    hint: hint.trim(),
    author,
    guesser: author === "Даша" ? "ты" : "Даша",
    guessed: new Set(),
    mistakes: 0,
    complete: false
  };
  renderHangman();
  return true;
}

function renderHangman() {
  const wordEl = document.querySelector("#hangman-word");
  const hintEl = document.querySelector("#hangman-hint");
  const ownerEl = document.querySelector("#round-owner");
  const mistakesEl = document.querySelector("#mistakes");
  const usedEl = document.querySelector("#used-letters");
  const resultEl = document.querySelector("#game-result");
  const lettersEl = document.querySelector("#letters");

  wordEl.innerHTML = "";
  hangman.word.split("").forEach((letter) => {
    const cell = document.createElement("span");
    cell.className = "word-cell";
    cell.textContent = hangman.guessed.has(letter) || hangman.complete ? letter : "";
    wordEl.append(cell);
  });

  if (hangman.author === "Набор") {
    ownerEl.textContent = "Сейчас слово выбрано из общего набора.";
  } else if (hangman.author === "Даша") {
    ownerEl.textContent = "Даша загадала слово для тебя.";
  } else {
    ownerEl.textContent = "Ты загадал слово для Даши.";
  }
  hintEl.textContent = `Подсказка: ${hangman.hint}`;
  mistakesEl.textContent = `Ошибки: ${hangman.mistakes} / 6`;
  const usedLetters = [...hangman.guessed].join(", ");
  usedEl.textContent = `Буквы: ${usedLetters || "нет"}`;

  lettersEl.innerHTML = "";
  alphabet.forEach((letter) => {
    const button = document.createElement("button");
    button.className = "letter";
    button.type = "button";
    button.textContent = letter;
    button.disabled = hangman.guessed.has(letter) || hangman.complete;
    button.addEventListener("click", () => guessLetter(letter));
    lettersEl.append(button);
  });

  const isWin = hangman.word.split("").every((letter) => hangman.guessed.has(letter));
  if (isWin && !hangman.complete) {
    hangman.complete = true;
    incrementPlayed();
  }

  if (hangman.mistakes >= 6 && !hangman.complete) {
    hangman.complete = true;
    incrementPlayed();
  }

  if (isWin) {
    resultEl.textContent = `Победа. ${hangman.guesser} раскрыл(а) слово, можно начинать следующий раунд.`;
  } else if (hangman.mistakes >= 6) {
    resultEl.textContent = `Раунд окончен. Было загадано слово: ${hangman.word}.`;
  } else {
    resultEl.textContent =
      hangman.author === "Набор"
        ? "Буквы можно открывать по очереди, как будто игра идёт в одной комнате."
        : "Слово спрятано. Теперь второй игрок выбирает буквы и смотрит только на подсказку.";
  }
}

function guessLetter(letter) {
  if (hangman.complete) return;
  hangman.guessed.add(letter);
  if (!hangman.word.includes(letter)) {
    hangman.mistakes += 1;
  }
  renderHangman();
}

function incrementPlayed() {
  const current = Number(localStorage.getItem(storageKeys.played) || "0") + 1;
  localStorage.setItem(storageKeys.played, String(current));
  updateCounters();
}

function initGames() {
  document.querySelector("#new-word").addEventListener("click", pickWord);
  document.querySelector("#hangman-setup").addEventListener("submit", (event) => {
    event.preventDefault();
    const author = document.querySelector("#hangman-author").value;
    const wordInput = document.querySelector("#custom-word");
    const hintInput = document.querySelector("#custom-hint");
    const started = startCustomRound(author, wordInput.value, hintInput.value);
    if (started) {
      wordInput.value = "";
      hintInput.value = "";
    }
  });
  document.querySelectorAll("[data-game]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-game]").forEach((tile) => {
        tile.classList.toggle("active", tile === button);
      });

      const selected = button.dataset.game;
      document.querySelector("#hangman-panel").classList.toggle("hidden", selected !== "hangman");
      document.querySelector("#coming-soon-panel").classList.toggle("hidden", selected === "hangman");

      if (selected !== "hangman") {
        document.querySelector("#coming-title").textContent = button.querySelector("strong").textContent;
        document.querySelector("#coming-text").textContent =
          selected === "balda"
            ? "Поле, ходы по очереди, слова и счёт добавим следующим игровым блоком."
            : "Лёгкий режим с вопросами друг другу для созвонов и спокойных вечеров.";
      }
    });
  });
  pickWord();
}

function fileToGalleryImage(file, onReady, onError) {
  let completed = false;
  const fallbackTimer = setTimeout(() => {
    if (!completed) {
      completed = true;
      onReady(file);
    }
  }, 6000);

  const finish = (blob) => {
    if (completed) return;
    completed = true;
    clearTimeout(fallbackTimer);
    onReady(blob);
  };

  const fail = () => {
    if (completed) return;
    completed = true;
    clearTimeout(fallbackTimer);
    onError?.();
  };

  const reader = new FileReader();
  reader.addEventListener("load", () => {
    const image = new Image();
    image.addEventListener("load", () => {
      const maxSize = 1000;
      const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");

      canvas.width = width;
      canvas.height = height;
      context.drawImage(image, 0, 0, width, height);
      canvas.toBlob((blob) => {
        if (!blob) {
          finish(file);
          return;
        }
        finish(blob);
      }, "image/jpeg", 0.78);
    });
    image.addEventListener("error", () => finish(file));
    image.src = reader.result;
  });
  reader.addEventListener("error", fail);
  reader.readAsDataURL(file);
}

async function deleteGalleryItem(id, version) {
  if (!sharedState.roomId) return;
  try {
    await apiRequest(`/gallery/${encodeURIComponent(id)}`, { method: "DELETE", version });
  } catch (error) {
    if (handleSessionError(error)) return;
    alert(error.status === 409 ? "Карточка уже изменилась на другом устройстве. Галерея будет обновлена." : "Не получилось удалить карточку.");
    if (error.status === 409) renderGallery();
    return;
  }

  await renderGallery();
}

function renderGalleryEmpty(grid) {
  const card = document.createElement("article");
  card.className = "gallery-card";
  const placeholder = document.createElement("div");
  placeholder.className = "placeholder-art";
  placeholder.textContent = "Галерея";
  const body = document.createElement("div");
  body.className = "gallery-card-body";
  const caption = document.createElement("p");
  caption.textContent = "Здесь будут фотографии, мемы и случайные находки.";
  body.append(caption);
  card.append(placeholder, body);
  grid.append(card);
}

function getUploadExtension(blob) {
  if (blob.type === "image/png") return "png";
  if (blob.type === "image/webp") return "webp";
  if (blob.type === "image/gif") return "gif";
  return "jpg";
}

async function getGalleryItems() {
  const data = await retryOnce(() => apiRequest("/gallery"));
  data.items.forEach((item) => imageUrlCache.set(item.storage_path, {
    url: item.imageUrl,
    expiresAt: Date.now() + (signedUrlTtlSeconds - 60) * 1000
  }));
  return data.items;
}

async function getGalleryImageUrl(storagePath) {
  const cached = imageUrlCache.get(storagePath);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url;
  }

  const items = await getGalleryItems();
  const item = items.find((candidate) => candidate.storage_path === storagePath);
  if (!item?.imageUrl) throw new Error("Нет ссылки на картинку.");
  return item.imageUrl;
}

async function loadGalleryImage(image, storagePath) {
  image.addEventListener(
    "error",
    () => {
      image.alt = "Картинка пока не открылась";
      setGalleryStatus("Картинка пока не открылась. Обновите страницу или попробуйте ещё раз.");
    },
    { once: true }
  );

  try {
    image.src = await getGalleryImageUrl(storagePath);
  } catch (error) {
    image.alt = "Картинка пока не открылась";
    setGalleryStatus(`Картинка пока не открылась: ${error.message}`);
  }
}

async function openPhotoViewer(storagePath, caption) {
  const viewer = document.querySelector("#photo-viewer");
  const image = document.querySelector("#photo-viewer-image");
  const captionEl = document.querySelector("#photo-viewer-caption");
  if (!viewer || !image || !captionEl) return;

  captionEl.textContent = caption || "";
  image.removeAttribute("src");
  viewer.classList.remove("hidden");
  image.addEventListener(
    "error",
    () => {
      captionEl.textContent = "Картинка пока не открылась. Обновите страницу или попробуйте ещё раз.";
    },
    { once: true }
  );

  try {
    image.src = await getGalleryImageUrl(storagePath);
  } catch (error) {
    captionEl.textContent = `Картинка пока не открылась: ${error.message}`;
  }
}

function closePhotoViewer() {
  const viewer = document.querySelector("#photo-viewer");
  const image = document.querySelector("#photo-viewer-image");
  const caption = document.querySelector("#photo-viewer-caption");
  viewer?.classList.add("hidden");
  image?.removeAttribute("src");
  if (caption) caption.textContent = "";
}

async function renderGallery() {
  const grid = document.querySelector("#gallery-grid");
  grid.innerHTML = "";

  if (!sharedState.roomId) {
    renderGalleryEmpty(grid);
    setGalleryStatus("Галерея ждёт входа.");
    return;
  }

  let items = [];
  try {
    setGalleryStatus("Загружаем галерею...");
    setSyncStatus("Загружаем общую комнату...");
    items = await getGalleryItems();
  } catch (error) {
    if (handleSessionError(error)) return;
    renderGalleryEmpty(grid);
    setSyncStatus("Не получилось прочитать общую галерею.");
    setGalleryStatus("Не получилось прочитать галерею.");
    return;
  }

  if (!items.length) {
    renderGalleryEmpty(grid);
    setGalleryStatus("Галерея пока пустая.");
    return;
  }

  items.forEach((item) => {
    const card = document.createElement("article");
    card.className = "gallery-card";

    const image = document.createElement("img");
    image.alt = item.caption || "Изображение из галереи";
    image.src = imagePlaceholder;
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("click", () => openPhotoViewer(item.storage_path, item.caption));
    card.append(image);
    loadGalleryImage(image, item.storage_path);

    const body = document.createElement("div");
    body.className = "gallery-card-body";
    const caption = document.createElement("p");
    caption.textContent = item.caption || "Без подписи";
    const date = document.createElement("time");
    date.className = "gallery-date";
    date.dateTime = item.created_at;
    date.textContent = new Date(item.created_at).toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "long"
    });
    const deleteButton = document.createElement("button");
    deleteButton.className = "gallery-delete";
    deleteButton.type = "button";
    deleteButton.textContent = "Удалить";
    deleteButton.setAttribute("aria-label", `Удалить из галереи: ${item.caption || "изображение"}`);
    deleteButton.addEventListener("click", () => {
      if (confirm("Удалить эту карточку из галереи?")) {
        deleteGalleryItem(item.id, item.version);
      }
    });
    body.append(caption, date, deleteButton);

    card.append(body);
    grid.append(card);
  });

  setSyncStatus("Общая комната подключена.");
  setGalleryStatus("Галерея подключена.");
}

function initGallery() {
  if (sharedState.galleryReady) {
    renderGallery();
    return;
  }
  sharedState.galleryReady = true;

  const fileInput = document.querySelector("#gallery-file");
  const fileName = document.querySelector("#gallery-file-name");
  const updateGalleryFileName = () => {
    if (!fileName || !fileInput) return;
    fileName.textContent = fileInput.files[0]?.name || "Файл не выбран";
  };

  fileInput?.addEventListener("change", updateGalleryFileName);

  document.querySelector("#gallery-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const file = fileInput?.files[0];
    const caption = document.querySelector("#gallery-caption").value.trim();
    if (!file || !sharedState.roomId) return;

    const submitButton = event.target.querySelector("button");
    submitButton.disabled = true;
    setGalleryStatus("Готовим картинку...");

    const saveItem = async (blob) => {
      try {
        setSyncStatus("Загружаем картинку...");
        setGalleryStatus("Загружаем картинку...");
        const intent = await apiRequest("/gallery/upload-intent", {
          method: "POST",
          body: { caption, contentType: blob.type || "image/jpeg", size: blob.size }
        });
        const uploadResponse = await withTimeout(fetch(intent.uploadUrl, {
          method: "PUT",
          headers: { "content-type": blob.type || "image/jpeg" },
          body: blob
        }), "Загрузка картинки долго не отвечает.");
        if (!uploadResponse.ok) throw new Error("Хранилище не приняло картинку.");
        await apiRequest("/gallery/complete", { method: "POST", body: { id: intent.item.id } });

        event.target.reset();
        updateGalleryFileName();
        setSyncStatus("Картинка сохранена в общей комнате.");
        setGalleryStatus("Картинка сохранена.");
        await renderGallery();
      } catch (error) {
        if (handleSessionError(error)) return;
        submitButton.disabled = false;
        setSyncStatus(`Не получилось добавить карточку: ${error.message}`);
        setGalleryStatus(`Не получилось добавить карточку: ${error.message}`);
        alert("Не получилось загрузить картинку.");
        return;
      }

      submitButton.disabled = false;
    };

    fileToGalleryImage(file, saveItem, () => {
      submitButton.disabled = false;
      setGalleryStatus("Не получилось подготовить картинку.");
    });
  });
  renderGallery();
}

function defaultMemories() {
  return [];
}

function getMemoryLabel(item) {
  return item.label || "момент";
}

function renderMemoryCalendar() {
  const calendar = document.querySelector("#calendar-grid");
  const title = document.querySelector("#calendar-title");
  const filter = document.querySelector("#calendar-filter");
  const filterText = document.querySelector("#calendar-filter-text");
  if (!calendar || !title || !filter || !filterText) return;

  const month = sharedState.memoryCalendarMonth || startOfMonth(new Date());
  sharedState.memoryCalendarMonth = month;
  title.textContent = formatMonthTitle(month);
  calendar.innerHTML = "";

  const items = [...sharedState.memoriesCache, ...sharedState.pendingMemories];
  const countsByDate = items.reduce((counts, item) => {
    const key = getMemoryDate(item);
    counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
  }, new Map());

  const firstDay = new Date(month.getFullYear(), month.getMonth(), 1);
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const leadingDays = (firstDay.getDay() + 6) % 7;

  for (let index = 0; index < leadingDays; index += 1) {
    const spacer = document.createElement("span");
    spacer.className = "calendar-day empty";
    calendar.append(spacer);
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(month.getFullYear(), month.getMonth(), day);
    const key = toDateKey(date);
    const count = countsByDate.get(key) || 0;
    const button = document.createElement("button");
    button.className = "calendar-day";
    button.type = "button";
    button.textContent = String(day);
    button.setAttribute("aria-label", `${formatDateKey(key)}${count ? `, записей: ${count}` : ""}`);

    if (key === todayKey()) {
      button.classList.add("today");
    }
    if (count) {
      button.classList.add("has-memory");
    }
    if (key === sharedState.selectedMemoryDate) {
      button.classList.add("selected");
    }

    button.addEventListener("click", () => {
      sharedState.selectedMemoryDate = key;
      const dateInput = document.querySelector("#memory-date");
      if (dateInput) {
        dateInput.value = key;
      }
      renderMemoriesFromCache();
    });
    calendar.append(button);
  }

  if (sharedState.selectedMemoryDate) {
    filter.classList.remove("hidden");
    filterText.textContent = formatDateKey(sharedState.selectedMemoryDate);
  } else {
    filter.classList.add("hidden");
    filterText.textContent = "";
  }
}

async function deleteMemoryItem(id, version) {
  if (!sharedState.roomId) return;
  try {
    await apiRequest(`/memories/${encodeURIComponent(id)}`, { method: "DELETE", version });
  } catch (error) {
    if (handleSessionError(error)) return;
    alert(error.status === 409 ? "Запись уже изменилась на другом устройстве. Лента будет обновлена." : "Не получилось удалить запись.");
    if (error.status === 409) renderMemories();
    return;
  }

  await renderMemories();
}

function renderMemoriesEmpty(timeline) {
  const card = document.createElement("article");
  card.className = "memory-card";
  const text = document.createElement("p");
  text.textContent = "Пока тут тихо.";
  card.append(text);
  timeline.append(card);
}

function appendMemoryCard(timeline, item) {
  const card = document.createElement("article");
  card.className = "memory-card";
  if (item.pending) {
    card.classList.add("pending");
  }
  const time = document.createElement("time");
  const memoryDate = getMemoryDate(item);
  time.dateTime = memoryDate;
  time.textContent = formatDateKey(memoryDate);
  const label = document.createElement("span");
  label.className = "memory-label";
  label.textContent = getMemoryLabel(item);
  const text = document.createElement("p");
  text.textContent = item.text;
  card.append(time, label, text);

  if (item.pending) {
    const pendingNote = document.createElement("span");
    pendingNote.className = "memory-pending";
    pendingNote.textContent = "Сохраняется...";
    card.append(pendingNote);
  } else {
    const deleteButton = document.createElement("button");
    deleteButton.className = "memory-delete";
    deleteButton.type = "button";
    deleteButton.textContent = "Удалить";
    deleteButton.setAttribute("aria-label", "Удалить запись из воспоминаний");
    deleteButton.addEventListener("click", () => {
      if (confirm("Удалить эту запись?")) {
        deleteMemoryItem(item.id, item.version);
      }
    });
    card.append(deleteButton);
  }

  timeline.append(card);
}

function getVisibleMemories(items) {
  if (!sharedState.selectedMemoryDate) return items;
  return items.filter((item) => getMemoryDate(item) === sharedState.selectedMemoryDate);
}

function renderMemoriesFromCache() {
  const timeline = document.querySelector("#timeline");
  timeline.innerHTML = "";
  renderMemoryCalendar();
  const items = getVisibleMemories([...sharedState.pendingMemories, ...sharedState.memoriesCache]);
  if (!items.length) {
    renderMemoriesEmpty(timeline);
    return;
  }
  items.forEach((item) => appendMemoryCard(timeline, item));
}

async function getMemories() {
  const data = await retryOnce(() => apiRequest("/memories"));
  return data.items;
}

async function renderMemories() {
  const timeline = document.querySelector("#timeline");
  timeline.innerHTML = "";

  if (!sharedState.roomId) {
    renderMemoryCalendar();
    renderMemoriesEmpty(timeline);
    return;
  }

  let memories = [];
  try {
    memories = await getMemories();
    sharedState.memoriesCache = memories;
  } catch (error) {
    if (handleSessionError(error)) return;
    if (sharedState.pendingMemories.length) {
      renderMemoriesFromCache();
    } else {
      renderMemoryCalendar();
      renderMemoriesEmpty(timeline);
    }
    setSyncStatus("Не получилось прочитать общую ленту.");
    return;
  }

  renderMemoriesFromCache();
}

function initMemories() {
  if (sharedState.memoriesReady) {
    renderMemories();
    return;
  }
  sharedState.memoriesReady = true;
  sharedState.memoryCalendarMonth = startOfMonth(new Date());

  const dateInput = document.querySelector("#memory-date");
  const labelInput = document.querySelector("#memory-label");
  if (dateInput && !dateInput.value) {
    dateInput.value = todayKey();
  }

  dateInput?.addEventListener("change", () => {
    if (!dateInput.value) return;
    sharedState.memoryCalendarMonth = startOfMonth(dateFromKey(dateInput.value));
    renderMemoryCalendar();
  });

  document.querySelector("#calendar-prev")?.addEventListener("click", () => {
    const month = sharedState.memoryCalendarMonth || startOfMonth(new Date());
    sharedState.memoryCalendarMonth = new Date(month.getFullYear(), month.getMonth() - 1, 1);
    renderMemoryCalendar();
  });

  document.querySelector("#calendar-next")?.addEventListener("click", () => {
    const month = sharedState.memoryCalendarMonth || startOfMonth(new Date());
    sharedState.memoryCalendarMonth = new Date(month.getFullYear(), month.getMonth() + 1, 1);
    renderMemoryCalendar();
  });

  document.querySelector("#calendar-clear")?.addEventListener("click", () => {
    sharedState.selectedMemoryDate = null;
    renderMemoriesFromCache();
  });

  document.querySelector("#memory-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.querySelector("#memory-text");
    const text = input.value.trim();
    if (!text || !sharedState.roomId) return;

    const submitButton = event.target.querySelector("button");
    const memoryDate = dateInput?.value || todayKey();
    const label = labelInput?.value || "момент";
    const pendingMemory = {
      id: `pending-${createId()}`,
      text,
      memory_date: memoryDate,
      label,
      created_at: new Date().toISOString(),
      pending: true
    };

    submitButton.disabled = true;
    input.value = "";
    sharedState.pendingMemories.unshift(pendingMemory);
    renderMemoriesFromCache();
    setSyncStatus("Сохраняем запись...");

    const slowSaveTimer = setTimeout(() => {
      submitButton.disabled = false;
      setSyncStatus("Связь медленная, но запись ещё сохраняется.");
    }, 10000);

    apiRequest("/memories", {
      method: "POST",
      body: { text, memoryDate, label }
    })
      .then(async () => {
        clearTimeout(slowSaveTimer);
        submitButton.disabled = false;
        sharedState.pendingMemories = sharedState.pendingMemories.filter((item) => item.id !== pendingMemory.id);
        setSyncStatus("Запись сохранена в общей комнате.");
        await renderMemories();
      })
      .catch((error) => {
        clearTimeout(slowSaveTimer);
        submitButton.disabled = false;
        if (handleSessionError(error)) return;
        setSyncStatus(`Не получилось сохранить запись: ${error.message}`);
        sharedState.pendingMemories = sharedState.pendingMemories.filter((item) => item.id !== pendingMemory.id);
        input.value = text;
        if (dateInput) dateInput.value = memoryDate;
        if (labelInput) labelInput.value = label;
        renderMemories();
        alert("Не получилось сохранить запись.");
      });
  });
  renderMemories();
}

function refreshActiveRoute() {
  if (!sharedState.initialized || document.hidden) return;
  if (sharedState.activeRoute === "gallery") renderGallery();
  if (sharedState.activeRoute === "memories") renderMemories();
}

function stopPolling() {
  if (sharedState.pollTimer) clearInterval(sharedState.pollTimer);
  sharedState.pollTimer = null;
}

function startPolling() {
  stopPolling();
  sharedState.pollTimer = setInterval(refreshActiveRoute, getApiConfig().pollIntervalMs);
}

function subscribe(roomId, handler) {
  const timer = setInterval(() => {
    if (!document.hidden && sharedState.roomId === roomId) handler({ type: "poll" });
  }, getApiConfig().pollIntervalMs);
  return () => clearInterval(timer);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshActiveRoute();
});

function defaultLinks() {
  return [
    {
      title: "MTS Link",
      url: "https://mts-link.ru/",
      note: "Созвоны, совместные просмотры и разговоры вечером."
    },
    {
      title: "Сериалы вместе",
      url: "https://www.kinopoisk.ru/",
      note: "Быстрый переход к выбору вечернего просмотра."
    },
    {
      title: "Спорт",
      url: "https://www.sports.ru/",
      note: "Матчи, новости и соревнования, которые смотрите вдвоём."
    }
  ];
}

function renderLinks() {
  const links = readJson(storageKeys.links, defaultLinks());
  const grid = document.querySelector("#links-grid");
  grid.innerHTML = "";

  links.forEach((item, index) => {
    const card = document.createElement("article");
    card.className = "quick-link";

    const link = document.createElement("a");
    link.className = "quick-link-main";
    link.href = item.url;
    link.target = "_blank";
    link.rel = "noreferrer";

    const body = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = item.title;
    const note = document.createElement("span");
    note.textContent = item.note || item.url;
    body.append(title, note);

    const icon = document.createElement("span");
    icon.className = "quick-link-icon";
    icon.textContent = "↗";

    link.append(body, icon);
    const deleteButton = document.createElement("button");
    deleteButton.className = "link-delete";
    deleteButton.type = "button";
    deleteButton.textContent = "Удалить";
    deleteButton.setAttribute("aria-label", `Удалить ссылку: ${item.title}`);
    deleteButton.addEventListener("click", () => {
      if (!confirm("Удалить эту ссылку?")) return;
      const currentLinks = readJson(storageKeys.links, defaultLinks());
      currentLinks.splice(index, 1);
      writeJson(storageKeys.links, currentLinks);
      renderLinks();
    });

    card.append(link, deleteButton);
    grid.append(card);
  });
}

function initLinks() {
  document.querySelector("#link-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const titleInput = document.querySelector("#link-title");
    const urlInput = document.querySelector("#link-url");
    const title = titleInput.value.trim();
    const url = urlInput.value.trim();
    if (!title || !url) return;

    const links = readJson(storageKeys.links, defaultLinks());
    links.unshift({ title, url, note: "В быстрых ссылках." });
    writeJson(storageKeys.links, links.slice(0, 12));
    event.target.reset();
    renderLinks();
  });
  renderLinks();
}

function updateCounters() {
}

function initPhotoViewer() {
  document.querySelector("#photo-viewer-close")?.addEventListener("click", closePhotoViewer);
  document.querySelector("#photo-viewer")?.addEventListener("click", (event) => {
    if (event.target.id === "photo-viewer") {
      closePhotoViewer();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closePhotoViewer();
    }
  });
}

function initLogout() {
  document.querySelector("#logout-button")?.addEventListener("click", async () => {
    try { await apiRequest("/auth/logout", { method: "POST" }); } catch {}
    stopPolling();
    sharedState.user = null;
    sharedState.roomId = null;
    sharedState.initialized = false;
    sharedState.pendingMemories = [];
    sharedState.memoriesCache = [];
    imageUrlCache.clear();
    document.body.classList.add("locked");
    document.body.classList.remove("unlocked");
  });
}

initAccessGate();
initRouter();
initGames();
initLinks();
initPhotoViewer();
initLogout();
updateCounters();
