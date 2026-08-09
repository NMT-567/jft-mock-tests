/**
 * groupRenderer.js
 * Builds the DOM for one group's shared block (passage/conversation/media)
 * and its question blocks. Used by BOTH js/exam.js (interactive, real
 * answers) and admin/js/preview.js (read-only, shows the correct answer
 * highlighted) — a single source of truth so the admin's live preview can
 * never visually drift from what students actually see.
 */
import { renderRichText, escapeHtml } from "./utils.js?v=5";

/** Build the shared passage/conversation/media block for a group, or null for "single". */
export function buildSharedBlock(group) {
  if (group.type === "single") return null;

  const wrap = document.createElement("div");
  wrap.className = "group-shared-block";

  if (group.title) {
    const title = document.createElement("h2");
    title.className = "group-shared-title";
    title.textContent = group.title;
    wrap.appendChild(title);
  }

  if (group.imageUrl) {
    const imgWrap = document.createElement("div");
    imgWrap.className = "group-media-wrap";
    const img = document.createElement("img");
    img.src = group.imageUrl;
    img.alt = "Group illustration";
    img.loading = "lazy";
    img.draggable = false;
    imgWrap.appendChild(img);
    wrap.appendChild(imgWrap);
  }

  if (group.audioUrl) {
    const audioWrap = document.createElement("div");
    audioWrap.className = "group-audio-wrap";
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "auto";
    audio.src = group.audioUrl;
    // controlsList="nodownload" hides the browser's native "⋮" menu's
    // download option (Chromium). This is a real attribute the audio
    // element itself reads, not something interceptable via a
    // contextmenu/right-click listener — the "⋮" menu is the browser's
    // own internal control-bar UI, not a page-level context menu, so
    // Session 14's existing right-click/copy blocking never applied to
    // it and couldn't have. disableRemotePlayback also hides the
    // cast-to-device option, another way media could leave the page.
    audio.setAttribute("controlslist", "nodownload");
    audio.disableRemotePlayback = true;
    audioWrap.appendChild(audio);
    wrap.appendChild(audioWrap);
  }

  if (group.type === "passage_group" && group.passageText) {
    const passage = document.createElement("div");
    passage.className = "question-passage";
    passage.innerHTML = renderRichText(group.passageText);
    wrap.appendChild(passage);
  }

  if (group.type === "conversation_group") {
    const convo = document.createElement("div");
    convo.className = "conversation-block";
    if (group.speakerAText) convo.appendChild(buildConversationLine(group.speakerAName, group.speakerAText, false));
    if (group.speakerBText) convo.appendChild(buildConversationLine(group.speakerBName, group.speakerBText, true));
    wrap.appendChild(convo);
  }

  return wrap;
}

export function buildConversationLine(name, text, isB) {
  const line = document.createElement("div");
  line.className = "conversation-line" + (isB ? " speaker-b" : "");
  const label = document.createElement("div");
  label.className = "conversation-speaker-name" + (isB ? " conversation-speaker-name-b" : "");
  label.textContent = name;
  const body = document.createElement("div");
  body.innerHTML = renderRichText(text);
  line.appendChild(label);
  line.appendChild(body);
  return line;
}

/**
 * Build one question's card.
 * @param {object} q - { id, text|question, options, correctOption, marks }
 * @param {number} orderNumber - the global "Q{n}" number to display
 * @param {object} group - the parent group (for single-type media)
 * @param {{
 *   readOnly?: boolean,           // true in admin preview: radios disabled, correct answer highlighted
 *   selectedAnswer?: string|null, // interactive mode only
 *   onSelectOption?: (option:string)=>void,
 *   bookmarked?: boolean,
 *   onToggleBookmark?: ()=>void,
 * }} options
 */
export function buildQuestionBlock(q, orderNumber, group, options = {}) {
  const { readOnly = false, selectedAnswer = null, onSelectOption, bookmarked = false, onToggleBookmark } = options;
  const questionText = q.text ?? q.question ?? "";

  const card = document.createElement("div");
  card.className = "card question-card";
  card.id = `question-anchor-${q.id}`;

  const header = document.createElement("div");
  header.className = "question-card-header";
  header.innerHTML = `
    <span class="question-index-badge">Q${orderNumber}</span>
    <div class="question-header-actions">
      <span class="question-marks">${q.marks ?? 1} mark${(q.marks ?? 1) === 1 ? "" : "s"}</span>
    </div>
  `;
  if (onToggleBookmark) {
    const bookmarkBtn = document.createElement("button");
    bookmarkBtn.type = "button";
    bookmarkBtn.className = "bookmark-btn";
    bookmarkBtn.setAttribute("aria-label", "Bookmark this question");
    bookmarkBtn.setAttribute("aria-pressed", String(bookmarked));
    bookmarkBtn.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;
    bookmarkBtn.addEventListener("click", onToggleBookmark);
    header.querySelector(".question-header-actions").appendChild(bookmarkBtn);
  }
  card.appendChild(header);

  // Standalone ("single") questions store their own image/audio on the
  // wrapping group object itself (group and question are 1:1 for that
  // type — see editor.js's optionalMediaField(ref.id, group, ...) call).
  // Grouped questions (passage_group / listening_group / etc.) are
  // different: the GROUP's own shared media (passage illustration,
  // listening clip) is rendered separately in buildSharedBlock() above,
  // but each individual question inside the group can ALSO carry its
  // own separate image/audio (e.g. a diagram for just that one
  // sub-question) — stored on the question's own bank entry, not the
  // group. This was previously never checked here at all for anything
  // other than "single", so a grouped question's own image/audio was
  // silently invisible everywhere this renders: admin editor, admin
  // preview, AND the real student exam (all three share this exact
  // function — see this file's header comment).
  const ownImageUrl = group.type === "single" ? group.imageUrl : q.imageUrl;
  const ownAudioUrl = group.type === "single" ? group.audioUrl : q.audioUrl;

  if (ownImageUrl) {
    const imgWrap = document.createElement("div");
    imgWrap.className = "question-image-wrap";
    imgWrap.innerHTML = `<img src="${escapeHtml(ownImageUrl)}" alt="Question illustration" loading="lazy" draggable="false" />`;
    card.appendChild(imgWrap);
  }
  if (ownAudioUrl) {
    const audioWrap = document.createElement("div");
    audioWrap.className = "question-audio-wrap";
    audioWrap.innerHTML = `<audio controls controlslist="nodownload" disableremoteplayback preload="auto" src="${escapeHtml(ownAudioUrl)}"></audio>`;
    card.appendChild(audioWrap);
  }

  const text = document.createElement("div");
  text.className = "question-text";
  text.innerHTML = renderRichText(questionText);
  card.appendChild(text);

  const optionsList = document.createElement("div");
  optionsList.className = "options-list";
  optionsList.setAttribute("role", "radiogroup");

  (q.options || []).filter((option) => (option || "").trim() !== "").forEach((option, i) => {
    const optionId = `opt-${q.id}-${i}`;
    const isCorrect = readOnly && option === q.correctOption;
    const isSelected = !readOnly && selectedAnswer === option;
    const wrapper = document.createElement("div");
    wrapper.className = "option-item" + (isSelected || isCorrect ? " selected" : "");

    const input = document.createElement("input");
    input.type = "radio";
    input.name = `question-${q.id}`;
    input.id = optionId;
    input.value = option;
    if (readOnly) {
      input.disabled = true;
      input.checked = isCorrect;
    } else {
      input.checked = isSelected;
      input.addEventListener("change", () => onSelectOption?.(option));
    }

    const label = document.createElement("label");
    label.setAttribute("for", optionId);
    label.textContent = option;

    wrapper.appendChild(input);
    wrapper.appendChild(label);
    if (!readOnly) {
      wrapper.addEventListener("click", (e) => {
        if (e.target !== input) input.click();
      });
    }
    optionsList.appendChild(wrapper);
  });
  card.appendChild(optionsList);

  if (readOnly && q.explanation) {
    const expl = document.createElement("div");
    expl.className = "review-explanation";
    expl.innerHTML = `<strong>Explanation: </strong>${escapeHtml(q.explanation)}`;
    card.appendChild(expl);
  }

  return card;
}
