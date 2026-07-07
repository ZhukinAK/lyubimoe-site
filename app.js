const storageKeys = {
  auth: "twoplace.auth",
  room: "twoplace.room",
  played: "twoplace.played",
  links: "twoplace.links"
};

const accessHash = "076ec7900688f607934e67e25391ee823594bb70f8940305fdb1d837a5a161b9";
const galleryBucket = "gallery";
const requestTimeoutMs = 180000;
const signedUrlTtlSeconds = 3600;
const imagePlaceholder =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3Crect width='1' height='1' fill='%23f8fbff'/%3E%3C/svg%3E";
const imageUrlCache = new Map();

let sharedState = {
  supabase: null,
  roomId: null,
  initialized: false,
  galleryReady: false,
  memoriesReady: false,
  pendingMemories: [],
  memoriesCache: [],
  memoryCalendarMonth: null,
  selectedMemoryDate: null,
  realtimeChannel: null
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

function getSupabaseConfig() {
  const config = window.LYUBIMOE_SUPABASE || {};
  return {
    url: (config.url || "").trim(),
    anonKey: (config.anonKey || "").trim(),
    roomSlug: (config.roomSlug || "preview").trim()
  };
}

function getSupabaseClient() {
  const config = getSupabaseConfig();
  if (!config.url || !config.anonKey || !window.supabase?.createClient) {
    return null;
  }

  if (!sharedState.supabase) {
    sharedState.supabase = window.supabase.createClient(config.url, config.anonKey);
  }

  return sharedState.supabase;
}

async function hashText(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unlockRoom() {
  document.body.classList.remove("locked");
  document.body.classList.add("unlocked");
}

function initAccessGate() {
  const form = document.querySelector("#auth-form");
  const input = document.querySelector("#auth-passphrase");
  const submit = form.querySelector("button");
  const error = document.querySelector("#auth-error");
  const supabaseClient = getSupabaseClient();

  if (!supabaseClient) {
    error.textContent = "Нужно заполнить Supabase URL и anon key в supabase-config.js.";
    submit.disabled = true;
    return;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    submit.disabled = true;

    try {
      const config = getSupabaseConfig();
      let { data: sessionData } = await supabaseClient.auth.getSession();
      if (!sessionData.session) {
        const { error: signInError } = await supabaseClient.auth.signInAnonymously();
        if (signInError) throw signInError;
      }

      const hash = await hashText(input.value.trim());
      if (hash !== accessHash) {
        throw new Error("Не та фраза.");
      }

      const { data: roomId, error: joinError } = await supabaseClient.rpc("join_room", {
        p_slug: config.roomSlug,
        p_passphrase: input.value.trim()
      });
      if (joinError) throw joinError;

      sharedState.roomId = roomId;
      localStorage.setItem(storageKeys.auth, accessHash);
      localStorage.setItem(storageKeys.room, roomId);
      input.value = "";
      unlockRoom();
      startSharedRoom();
    } catch (errorValue) {
      error.textContent = errorValue.message || "Не получилось войти.";
      input.select();
    } finally {
      submit.disabled = false;
    }
  });

  if (localStorage.getItem(storageKeys.auth) === accessHash && localStorage.getItem(storageKeys.room)) {
    supabaseClient.auth.getSession().then(({ data }) => {
      if (!data.session) {
        localStorage.removeItem(storageKeys.auth);
        localStorage.removeItem(storageKeys.room);
        return;
      }

      sharedState.roomId = localStorage.getItem(storageKeys.room);
      unlockRoom();
      startSharedRoom();
    });
  }
}

function startSharedRoom() {
  if (sharedState.initialized || !sharedState.roomId) return;
  sharedState.initialized = true;
  setSyncStatus("Общая комната подключена.");
  initGallery();
  initMemories();
  initRealtime();
}

function setRoute(route) {
  const nextRoute = route || "home";
  document.querySelectorAll("[data-view]").forEach((view) => {
    view.classList.toggle("active", view.id === nextRoute);
  });
  document.querySelectorAll("[data-route]").forEach((link) => {
    link.classList.toggle("active", link.dataset.route === nextRoute);
  });
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

async function deleteGalleryItem(id) {
  if (!sharedState.supabase || !sharedState.roomId) return;
  const { error } = await sharedState.supabase
    .from("gallery_items")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("room_id", sharedState.roomId);

  if (error) {
    alert("Не получилось удалить карточку.");
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
  const { data, error } = await retryOnce(() =>
    withTimeout(
      sharedState.supabase
        .from("gallery_items")
        .select("id, caption, storage_path, created_at")
        .eq("room_id", sharedState.roomId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false }),
      "Галерея долго не отвечает."
    )
  );

  if (error) throw error;
  return data;
}

async function getGalleryImageUrl(storagePath) {
  const cached = imageUrlCache.get(storagePath);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url;
  }

  try {
    const { data, error } = await retryOnce(() =>
      withTimeout(
        sharedState.supabase.storage.from(galleryBucket).createSignedUrl(storagePath, signedUrlTtlSeconds),
        "Картинка долго не отвечает."
      )
    );

    if (error || !data?.signedUrl) throw error || new Error("Нет ссылки на картинку.");
    imageUrlCache.set(storagePath, {
      url: data.signedUrl,
      expiresAt: Date.now() + (signedUrlTtlSeconds - 60) * 1000
    });
    return data.signedUrl;
  } catch (signedUrlError) {
    const { data, error } = await retryOnce(() =>
      withTimeout(
        sharedState.supabase.storage.from(galleryBucket).download(storagePath),
        "Картинка долго не отвечает."
      )
    );

    if (error || !data) throw error || signedUrlError;
    const dataUrl = await blobToDataUrl(data);
    imageUrlCache.set(storagePath, {
      url: dataUrl,
      expiresAt: Date.now() + 10 * 60 * 1000
    });
    return dataUrl;
  }
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

  if (!sharedState.supabase || !sharedState.roomId) {
    renderGalleryEmpty(grid);
    setGalleryStatus("Галерея ждёт входа.");
    return;
  }

  let items = [];
  try {
    setGalleryStatus("Загружаем галерею...");
    setSyncStatus("Загружаем общую комнату...");
    items = await getGalleryItems();
  } catch {
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
        deleteGalleryItem(item.id);
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
    if (!file || !sharedState.supabase || !sharedState.roomId) return;

    const submitButton = event.target.querySelector("button");
    submitButton.disabled = true;
    setGalleryStatus("Готовим картинку...");

    const saveItem = async (blob) => {
      const id = createId();
      const extension = getUploadExtension(blob);
      const storagePath = `${sharedState.roomId}/${id}.${extension}`;
      try {
        setSyncStatus("Загружаем картинку...");
        setGalleryStatus("Загружаем картинку...");
        const { error: uploadError } = await withTimeout(
          sharedState.supabase.storage.from(galleryBucket).upload(storagePath, blob, {
            contentType: blob.type || "image/jpeg",
            upsert: false
          }),
          "Загрузка картинки долго не отвечает."
        );

        if (uploadError) throw uploadError;

        const { error: insertError } = await withTimeout(
          sharedState.supabase.from("gallery_items").insert({
            room_id: sharedState.roomId,
            caption,
            storage_path: storagePath
          }),
          "Сохранение карточки долго не отвечает."
        );

        if (insertError) throw insertError;

        event.target.reset();
        updateGalleryFileName();
        setSyncStatus("Картинка сохранена в общей комнате.");
        setGalleryStatus("Картинка сохранена.");
        await renderGallery();
      } catch (error) {
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

async function deleteMemoryItem(id) {
  if (!sharedState.supabase || !sharedState.roomId) return;
  const { error } = await sharedState.supabase
    .from("memories")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("room_id", sharedState.roomId);

  if (error) {
    alert("Не получилось удалить запись.");
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
        deleteMemoryItem(item.id);
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
  const { data, error } = await retryOnce(() =>
    withTimeout(
      sharedState.supabase
        .from("memories")
        .select("id, text, memory_date, label, created_at")
        .eq("room_id", sharedState.roomId)
        .is("deleted_at", null)
        .order("memory_date", { ascending: false })
        .order("created_at", { ascending: false }),
      "Лента долго не отвечает."
    )
  );

  if (error) throw error;
  return data;
}

async function renderMemories() {
  const timeline = document.querySelector("#timeline");
  timeline.innerHTML = "";

  if (!sharedState.supabase || !sharedState.roomId) {
    renderMemoryCalendar();
    renderMemoriesEmpty(timeline);
    return;
  }

  let memories = [];
  try {
    memories = await getMemories();
    sharedState.memoriesCache = memories;
  } catch {
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
    if (!text || !sharedState.supabase || !sharedState.roomId) return;

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

    sharedState.supabase
      .from("memories")
      .insert({ room_id: sharedState.roomId, text, memory_date: memoryDate, label })
      .then(async ({ error }) => {
        clearTimeout(slowSaveTimer);
        submitButton.disabled = false;
        if (error) {
          setSyncStatus(`Не получилось сохранить запись: ${error.message}`);
          sharedState.pendingMemories = sharedState.pendingMemories.filter((item) => item.id !== pendingMemory.id);
          input.value = text;
          if (dateInput) dateInput.value = memoryDate;
          if (labelInput) labelInput.value = label;
          renderMemories();
          alert("Не получилось сохранить запись.");
          return;
        }
        sharedState.pendingMemories = sharedState.pendingMemories.filter((item) => item.id !== pendingMemory.id);
        setSyncStatus("Запись сохранена в общей комнате.");
        await renderMemories();
      })
      .catch((error) => {
        clearTimeout(slowSaveTimer);
        submitButton.disabled = false;
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

function initRealtime() {
  if (!sharedState.supabase || !sharedState.roomId) return;

  if (sharedState.realtimeChannel) {
    sharedState.supabase.removeChannel(sharedState.realtimeChannel);
  }

  sharedState.realtimeChannel = sharedState.supabase
    .channel(`room-${sharedState.roomId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "gallery_items",
        filter: `room_id=eq.${sharedState.roomId}`
      },
      () => renderGallery()
    )
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "memories",
        filter: `room_id=eq.${sharedState.roomId}`
      },
      () => renderMemories()
    )
    .subscribe();
}

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

initAccessGate();
initRouter();
initGames();
initLinks();
initPhotoViewer();
updateCounters();
