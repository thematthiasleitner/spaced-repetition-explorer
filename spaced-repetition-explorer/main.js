const {
  ItemView,
  MarkdownRenderer,
  Notice,
  Plugin,
  TFile,
  setIcon,
  normalizePath,
  PluginSettingTab,
  Setting,
} = require("obsidian");

const VIEW_TYPE = "spaced-repetition-explorer-view";
const DEFAULT_DECK_NAME = "Default";

const DEFAULT_EXPLORER_SETTINGS = {
  showRibbonIcon: true,
  useSrIgnoreFolders: true,
};

// Minimal subset of spaced-repetition defaults we rely on.
const DEFAULT_SR_SETTINGS = {
  flashcardTags: ["#flashcards"],
  convertFoldersToDecks: true,
  singleLineCardSeparator: "::",
  singleLineReversedCardSeparator: ":::" ,
  multilineCardSeparator: "?",
  multilineReversedCardSeparator: "??",
  multilineCardEndMarker: "",
  clozePatterns: [],
  convertHighlightsToClozes: false,
  convertBoldTextToClozes: false,
  convertCurlyBracketsToClozes: false,
  baseEase: 250,
  noteFoldersToIgnore: [],
};

const COLLAPSE_ICON = '<svg viewBox="0 0 100 100" width="8" height="8" class="svg-icon right-triangle"><path fill="currentColor" stroke="currentColor" d="M94.9,20.8c-1.4-2.5-4.1-4.1-7.1-4.1H12.2c-3,0-5.7,1.6-7.1,4.1c-1.3,2.4-1.2,5.2,0.2,7.6L43.1,88c1.5,2.3,4,3.7,6.9,3.7 s5.4-1.4,6.9-3.7l37.8-59.6C96.1,26,96.2,23.2,94.9,20.8L94.9,20.8z"></path></svg>';

const IMAGE_FORMATS = [
  "jpg",
  "jpeg",
  "gif",
  "png",
  "svg",
  "webp",
  "apng",
  "avif",
  "jfif",
  "pjpeg",
  "pjp",
];
const AUDIO_FORMATS = ["mp3", "wav", "m4a", "flac", "ogg", "oga", "opus"];
const VIDEO_FORMATS = ["mp4", "m4v", "mov", "webm", "ogv"];

class DeckNode {
  constructor(name, parent = null) {
    this.name = name;
    this.parent = parent;
    this.subdecks = [];
    this.cards = [];
  }
  get isRoot() {
    return this.parent === null;
  }
  get path() {
    if (this.isRoot) return "";
    const parts = [];
    let node = this;
    while (!node.isRoot) {
      parts.unshift(node.name);
      node = node.parent;
    }
    return parts.join("/");
  }
  getOrCreateChild(name) {
    let child = this.subdecks.find((d) => d.name === name);
    if (!child) {
      child = new DeckNode(name, this);
      this.subdecks.push(child);
    }
    return child;
  }
  addCard(card) {
    this.cards.push(card);
  }
  getAllCards() {
    let all = [...this.cards];
    for (const sub of this.subdecks) {
      all = all.concat(sub.getAllCards());
    }
    return all;
  }
  getTotalCount() {
    return this.getAllCards().length;
  }
  sortSubdecks() {
    this.subdecks.sort((a, b) => a.name.localeCompare(b.name));
    for (const sub of this.subdecks) {
      sub.sortSubdecks();
    }
  }
}

class ExplorerSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Spaced Repetition Explorer" });

    new Setting(containerEl)
      .setName("Show ribbon icon")
      .setDesc("Show a ribbon button (same icon as spaced repetition) to open the explorer.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.explorerSettings.showRibbonIcon);
        toggle.onChange(async (value) => {
          this.plugin.explorerSettings.showRibbonIcon = value;
          await this.plugin.saveExplorerSettings();
        });
      });

    new Setting(containerEl)
      .setName("Apply spaced-repetition ignore folders")
      .setDesc("Use the spaced-repetition plugin's 'Folders to ignore' list when collecting cards.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.explorerSettings.useSrIgnoreFolders);
        toggle.onChange(async (value) => {
          this.plugin.explorerSettings.useSrIgnoreFolders = value;
          await this.plugin.saveExplorerSettings();
        });
      });

    new Setting(containerEl)
      .setName("Refresh data")
      .setDesc("Rescan the vault for flashcards and reload the explorer view.")
      .addButton((button) => {
        button.setButtonText("Refresh now");
        button.onClick(async () => {
          button.setDisabled(true);
          await this.plugin.refreshCache();
          const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
          if (leaf?.view?.loadCards) {
            await leaf.view.loadCards();
          }
          new Notice("Spaced Repetition Explorer refreshed");
          button.setDisabled(false);
        });
      });
  }
}

class SpacedRepetitionExplorerPlugin extends Plugin {
  async onload() {
    this.explorerSettings = await this.loadExplorerSettings();
    this.srSettings = await this.loadSpacedRepetitionSettings();
    this.updateRibbonIcon();
    this.registerView(
      VIEW_TYPE,
      (leaf) => new SpacedRepetitionExplorerView(leaf, this)
    );

    this.addCommand({
      id: "open-sr-explorer",
      name: "Open spaced-repetition explorer",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "refresh-sr-explorer",
      name: "Refresh explorer data",
      callback: async () => {
        await this.refreshCache();
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
        if (leaf?.view?.loadCards) {
          await leaf.view.loadCards();
        }
        new Notice("Spaced Repetition Explorer refreshed");
      },
    });

    this.addSettingTab(new ExplorerSettingTab(this.app, this));
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    if (this.ribbonIconEl) {
      this.ribbonIconEl.detach();
      this.ribbonIconEl = null;
    }
  }

  async activateView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length > 0) {
      leaves[0].setViewState({ type: VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(leaves[0]);
      return;
    }
    await this.app.workspace.getRightLeaf(false).setViewState({
      type: VIEW_TYPE,
      active: true,
    });
    this.app.workspace.revealLeaf(
      this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]
    );
  }

  async loadSpacedRepetitionSettings() {
    const adapter = this.app.vault.adapter;
    const path = normalizePath(
      ".obsidian/plugins/obsidian-spaced-repetition/data.json"
    );
    let loaded = {};
    try {
      const raw = await adapter.read(path);
      loaded = JSON.parse(raw).settings || {};
    } catch (err) {
      console.warn("[Spaced Repetition Explorer] Could not load spaced-repetition settings; using defaults.", err);
    }
    const merged = { ...DEFAULT_SR_SETTINGS, ...loaded };
    if (!Array.isArray(merged.clozePatterns)) {
      merged.clozePatterns = [];
    }
    // Mirror the spaced-repetition upgrade logic for cloze patterns.
    if (merged.clozePatterns.length === 0) {
      if (merged.convertHighlightsToClozes) {
        merged.clozePatterns.push("==[123;;]answer[;;hint]==");
      }
      if (merged.convertBoldTextToClozes) {
        merged.clozePatterns.push("**[123;;]answer[;;hint]**");
      }
      if (merged.convertCurlyBracketsToClozes) {
        merged.clozePatterns.push("{{[123;;]answer[;;hint]}}");
      }
    }
    return merged;
  }

  async refreshCache() {
    this.cachedCards = null;
  }

  async collectCards() {
    if (this.cachedCards) return this.cachedCards;
    const files = this.app.vault.getMarkdownFiles();
    const cards = [];
    const deckSet = new Set();
    for (const file of files) {
      if (this.shouldIgnoreFile(file)) continue;
      const deckNames = this.getDeckNamesForFile(file);
      const content = await this.app.vault.read(file);
      const parsedQuestions = parseQuestions(content, this.srSettings);
      for (const question of parsedQuestions) {
        const frontsBacks = expandQuestion(question, this.srSettings);
        const schedules = extractSchedules(
          question.rawText,
          frontsBacks.length,
          this.srSettings.baseEase
        );
        for (let idx = 0; idx < frontsBacks.length; idx++) {
          const schedule = schedules[idx] || {};
          for (const deckName of deckNames) {
            const entry = {
              id: `${file.path}:${question.firstLine}:${idx}`,
              deck: deckName,
              filePath: file.path,
              line: question.firstLine + 1,
              front: frontsBacks[idx].front.trim(),
              back: frontsBacks[idx].back.trim(),
              ease: schedule.ease ?? this.srSettings.baseEase,
              interval: schedule.interval ?? null,
              due: schedule.due ?? null,
            };
            cards.push(entry);
            deckSet.add(deckName);
          }
        }
      }
    }
    cards.sort((a, b) => {
      const easeA = a.ease ?? Number.MAX_SAFE_INTEGER;
      const easeB = b.ease ?? Number.MAX_SAFE_INTEGER;
      if (easeA !== easeB) return easeA - easeB;
      return a.front.localeCompare(b.front);
    });
    const deckTree = buildDeckTree(cards);
    this.cachedCards = { cards, decks: Array.from(deckSet).sort(), deckTree };
    return this.cachedCards;
  }

  shouldIgnoreFile(file) {
    if (!(file instanceof TFile)) return true;
    const patterns = this.explorerSettings.useSrIgnoreFolders ? this.srSettings.noteFoldersToIgnore || [] : [];
    const filePath = file.path;
    for (const pattern of patterns) {
      if (pattern && pathMatchesPattern(filePath, pattern)) {
        return true;
      }
    }
    return false;
  }

  getDeckNamesForFile(file) {
    const deckNames = [];
    const settings = this.srSettings;
    if (settings.convertFoldersToDecks) {
      const folder = file.parent ? file.parent.path : "";
      deckNames.push(folder || DEFAULT_DECK_NAME);
    } else {
      const cache = this.app.metadataCache.getFileCache(file);
      if (cache?.tags) {
        for (const tag of cache.tags) {
          const topic = topicPathFromTag(tag.tag, settings.flashcardTags);
          if (topic !== null) deckNames.push(topic || DEFAULT_DECK_NAME);
        }
      }
    }
    if (deckNames.length === 0) deckNames.push(DEFAULT_DECK_NAME);
    return [...new Set(deckNames)];
  }
  async loadExplorerSettings() {
    const stored = await this.loadData();
    return Object.assign({}, DEFAULT_EXPLORER_SETTINGS, stored || {});
  }

  async saveExplorerSettings() {
    await this.saveData(this.explorerSettings);
    this.updateRibbonIcon();
  }

  updateRibbonIcon() {
    if (this.explorerSettings.showRibbonIcon) {
      if (!this.ribbonIconEl) {
        this.ribbonIconEl = this.addRibbonIcon(
          "SpacedRepIcon",
          "Explore flashcards",
          () => this.activateView()
        );
      }
    } else if (this.ribbonIconEl) {
      this.ribbonIconEl.detach();
      this.ribbonIconEl = null;
    }
  }
}

class SpacedRepetitionExplorerView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.filteredCards = [];
    this.currentIndex = 0;
    this.mode = "front";
    this.sortMode = "ease";
    this.keydownHandler = (e2) => {
      if (this.cardViewEl?.hasClass("sr-is-hidden")) return;
      if (document.activeElement?.tagName === "TEXTAREA") return;
      switch (e2.code) {
        case "Space":
          e2.preventDefault();
          this.toggleAnswer();
          break;
        case "ArrowRight":
          e2.preventDefault();
          this.shiftCard(1);
          break;
        case "ArrowLeft":
          e2.preventDefault();
          this.shiftCard(-1);
          break;
        default:
          break;
      }
    };
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Spaced Repetition Explorer";
  }

  getIcon() {
    return "SpacedRepIcon";
  }

  async onClose() {
    document.removeEventListener("keydown", this.keydownHandler);
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("sr-tab-view-content");
    this._initDeckList();
    this._initCardView();
    await this.loadCards();
    this.showDecks();
  }

  async loadCards() {
    const { cards, deckTree } = await this.plugin.collectCards();
    this.cards = cards;
    this.deckTree = deckTree;
    this._renderDeckList();
  }

  _initDeckList() {
    this.deckListEl = this.contentEl.createDiv();
    this.deckListEl.addClasses(["sr-deck-list"]);
    this.deckHeader = this.deckListEl.createDiv("sr-header");
    this.deckTitle = this.deckHeader.createDiv("sr-title");
    this.deckTitle.setText("Decks");
    this.deckStats = this.deckHeader.createDiv("sr-header-stats-container");
    this.sortSelect = this.deckHeader.createEl("select", { cls: "sr-sort-select" });
    this.sortSelect.createEl("option", { value: "ease", text: "Sort: Ease" });
    this.sortSelect.createEl("option", { value: "due", text: "Sort: Due date" });
    this.sortSelect.onchange = () => {
      this.sortMode = this.sortSelect.value;
      if (this.activeDeck) {
        this.showDeck(this.activeDeck);
      }
    };
    this.deckHeader.createEl("hr");
    this.deckContent = this.deckListEl.createDiv("sr-content");
  }

  _initCardView() {
    this.cardViewEl = this.contentEl.createDiv();
    this.cardViewEl.addClasses(["sr-flashcard", "sr-is-hidden"]);

    this.controls = this.cardViewEl.createDiv("sr-controls");
    this.backButton = this.controls.createEl("button", { cls: "sr-button sr-back-button" });
    setIcon(this.backButton, "arrow-left");
    this.backButton.setAttr("aria-label", "Back to decks");
    this.backButton.onclick = () => this.showDecks();

    this.prevButton = this.controls.createEl("button", { cls: "sr-button" });
    setIcon(this.prevButton, "chevron-left");
    this.prevButton.setAttr("aria-label", "Previous card");
    this.prevButton.onclick = () => this.shiftCard(-1);

    this.nextButton = this.controls.createEl("button", { cls: "sr-button" });
    setIcon(this.nextButton, "chevron-right");
    this.nextButton.setAttr("aria-label", "Next card");
    this.nextButton.onclick = () => this.shiftCard(1);

    this.infoSection = this.cardViewEl.createDiv("sr-info-section");
    this.deckInfo = this.infoSection.createDiv("sr-deck-progress-info");
    this.deckNameEl = this.deckInfo.createDiv("sr-chosen-deck-name");
    this.deckCountEl = this.deckInfo.createDiv("sr-chosen-deck-card-counter");
    this.easeEl = this.infoSection.createDiv("sr-context");

    this.content = this.cardViewEl.createDiv("sr-content");
    this.frontEl = this.content.createDiv("sr-question");
    this.separatorEl = this.content.createEl("hr");
    this.separatorEl.addClass("sr-is-hidden");
    this.backEl = this.content.createDiv("sr-answer");
    this.backEl.addClass("sr-is-hidden");

    this.response = this.cardViewEl.createDiv("sr-response");
    this.answerButton = this.response.createEl("button", { cls: "sr-button" });
    this.answerButton.style.width = "100%";
    this.answerButton.setText("Show answer (Space)");
    this.answerButton.onclick = () => this.toggleAnswer();
  }

  _renderDeckList() {
    this.deckContent.empty();
    this.deckStats.empty();
    const total = this.cards ? this.cards.length : 0;
    const statsContainer = this.deckStats.createDiv();
    statsContainer.addClasses(["tag-pane-tag-count", "tree-item-flair", "sr-header-stats-count", "sr-bg-blue"]);
    statsContainer.setText(`${total} cards`);
    if (!this.deckTree) return;
    this.deckTree.sortSubdecks();
    for (const sub of this.deckTree.subdecks) {
      this._createDeckTreeRow(sub, this.deckContent);
    }
  }

  _createDeckTreeRow(deckNode, container) {
    const deckTree = container.createDiv("tree-item sr-tree-item-container");
    const deckTreeSelf = deckTree.createDiv(
      "tree-item-self tag-pane-tag is-clickable sr-tree-item-row"
    );
    let collapsed = true;
    let collapseIconEl = null;
    if (deckNode.subdecks.length > 0) {
      collapseIconEl = deckTreeSelf.createDiv("tree-item-icon collapse-icon");
      collapseIconEl.innerHTML = COLLAPSE_ICON;
      collapseIconEl.childNodes[0].style.transform = "rotate(-90deg)";
    }
    const deckTreeInner = deckTreeSelf.createDiv("tree-item-inner");
    const deckTreeInnerText = deckTreeInner.createDiv("tag-pane-tag-text");
    deckTreeInnerText.innerHTML = `<span class="tag-pane-tag-self">${deckNode.name}</span>`;
    const deckTreeOuter = deckTreeSelf.createDiv();
    deckTreeOuter.addClasses(["tree-item-flair-outer", "sr-tree-stats-container"]);
    const statsContainer = deckTreeOuter.createDiv();
    statsContainer.addClasses([
      "tag-pane-tag-count",
      "tree-item-flair",
      "sr-tree-stats-count",
      "sr-bg-blue",
    ]);
    statsContainer.setText(deckNode.getTotalCount().toString());
    const deckTreeChildren = deckTree.createDiv("tree-item-children");
    deckTreeChildren.style.display = "none";
    if (deckNode.subdecks.length > 0 && collapseIconEl) {
      collapseIconEl.addEventListener("click", (e2) => {
        collapsed = !collapsed;
        deckTreeChildren.style.display = collapsed ? "none" : "block";
        collapseIconEl.childNodes[0].style.transform = collapsed ? "rotate(-90deg)" : "";
        e2.stopPropagation();
      });
    }
    deckTreeSelf.addEventListener("click", () => {
      this.showDeck(deckNode);
    });
    for (const sub of deckNode.subdecks) {
      this._createDeckTreeRow(sub, deckTreeChildren);
    }
  }

  showDeck(deckNode) {
    this.activeDeck = deckNode;
    this.filteredCards = deckNode.getAllCards().slice();
    this.filteredCards.sort((a, b) => {
      if (this.sortMode === "due") {
        const dueA = parseDueDate(a.due);
        const dueB = parseDueDate(b.due);
        if (dueA !== dueB) return dueA - dueB;
      } else {
        const easeA = a.ease ?? Number.MAX_SAFE_INTEGER;
        const easeB = b.ease ?? Number.MAX_SAFE_INTEGER;
        if (easeA !== easeB) return easeA - easeB;
      }
      return a.front.localeCompare(b.front);
    });
    this.currentIndex = 0;
    this.showFlashcards();
    this.renderActiveCard();
  }

  showDecks() {
    document.removeEventListener("keydown", this.keydownHandler);
    this.cardViewEl.addClass("sr-is-hidden");
    this.deckListEl.removeClass("sr-is-hidden");
  }

  showFlashcards() {
    document.addEventListener("keydown", this.keydownHandler);
    this.deckListEl.addClass("sr-is-hidden");
    this.cardViewEl.removeClass("sr-is-hidden");
  }

  renderActiveCard() {
    this.frontEl.empty();
    this.backEl.empty();
    this.backEl.addClass("sr-is-hidden");
    this.separatorEl.addClass("sr-is-hidden");
    this.mode = "front";
    if (!this.filteredCards || this.filteredCards.length === 0) {
      this.frontEl.setText("No flashcards found for this deck.");
      this.deckNameEl.setText(this.activeDeck ? this.activeDeck.name : "No deck");
      this.deckCountEl.setText("0/0");
      this.easeEl.setText("");
      return;
    }
    const card = this.filteredCards[this.currentIndex];
    this.deckNameEl.setText(`${this.activeDeck ? this.activeDeck.name : card.deck}`);
    this.deckCountEl.setText(`${this.currentIndex + 1}/${this.filteredCards.length}`);
    const dueLabel = card.due ? `Due ${card.due}` : "Due n/a";
    this.easeEl.setText(`Ease ${card.ease ?? this.plugin.srSettings.baseEase} · ${dueLabel}`);

    const wrapper = new RenderMarkdownWrapper(
      this.app,
      this.plugin,
      card.filePath
    );
    wrapper.renderMarkdownWrapper(card.front.trimStart(), this.frontEl, null);
    this.answerButton.removeClass("sr-bg-green");
    this.answerButton.setText("Show answer (Space)");
  }

  toggleAnswer() {
    if (!this.filteredCards || this.filteredCards.length === 0) return;
    const card = this.filteredCards[this.currentIndex];
    if (this.mode === "front") {
      this.mode = "back";
      const wrapper = new RenderMarkdownWrapper(
        this.app,
        this.plugin,
        card.filePath
      );
      this.backEl.empty();
      wrapper.renderMarkdownWrapper(card.back, this.backEl, null);
      this.backEl.removeClass("sr-is-hidden");
      this.separatorEl.removeClass("sr-is-hidden");
      this.answerButton.addClass("sr-bg-green");
      this.answerButton.setText("Hide answer (Space)");
    } else {
      this.renderActiveCard();
    }
  }

  shiftCard(delta) {
    const total = this.filteredCards.length;
    if (total === 0) return;
    this.currentIndex = (this.currentIndex + delta + total) % total;
    this.renderActiveCard();
  }
}

// --- Parsing helpers ---
class ParsedQuestion {
  constructor(type, rawText, firstLine, lastLine) {
    this.type = type;
    this.rawText = rawText;
    this.firstLine = firstLine;
    this.lastLine = lastLine;
  }
}

const QuestionType = {
  SingleLineBasic: 0,
  SingleLineReversed: 1,
  MultiLineBasic: 2,
  MultiLineReversed: 3,
  Cloze: 4,
};

function parseQuestions(text, settings) {
  const inlineSeparators = [
    { separator: settings.singleLineCardSeparator, type: QuestionType.SingleLineBasic },
    { separator: settings.singleLineReversedCardSeparator, type: QuestionType.SingleLineReversed },
  ].sort((a, b) => b.separator.length - a.separator.length);
  const cards = [];
  let cardText = "";
  let cardType = null;
  let firstLineNo = 0;
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (line.startsWith("<!--") && !line.startsWith("<!--SR:")) {
      while (i + 1 < lines.length && !line.includes("-->")) i++;
      i++;
      continue;
    }
    const isEmpty = trimmed.length === 0;
    const hasEndMarker =
      settings.multilineCardEndMarker &&
      trimmed === settings.multilineCardEndMarker;
    if ((isEmpty && !settings.multilineCardEndMarker) || (isEmpty && cardType === null) || hasEndMarker) {
      if (cardType !== null) {
        cards.push(
          new ParsedQuestion(
            cardType,
            cardText.trimEnd(),
            firstLineNo,
            i - 1
          )
        );
        cardType = null;
      }
      cardText = "";
      firstLineNo = i + 1;
      continue;
    }
    if (cardText.length > 0) cardText += "\n";
    cardText += line.trimEnd();

    for (const { separator, type } of inlineSeparators) {
      if (hasInlineMarker(line, separator)) {
        cardType = type;
        break;
      }
    }

    if (
      cardType === QuestionType.SingleLineBasic ||
      cardType === QuestionType.SingleLineReversed
    ) {
      // Pull scheduling info from the next line if present
      if (i + 1 < lines.length && lines[i + 1].startsWith("<!--SR:")) {
        cardText += "\n" + lines[i + 1];
        i++;
      }
      cards.push(
        new ParsedQuestion(cardType, cardText, firstLineNo, i)
      );
      cardType = null;
      cardText = "";
      continue;
    }

    if (trimmed === settings.multilineCardSeparator) {
      if (cardText.length > 1) {
        cardType = QuestionType.MultiLineBasic;
      }
    } else if (trimmed === settings.multilineReversedCardSeparator) {
      if (cardText.length > 1) {
        cardType = QuestionType.MultiLineReversed;
      }
    } else if (line.startsWith("```") || line.startsWith("~~~")) {
      const fence = line.match(/`+|~+/)[0];
      while (i + 1 < lines.length && !lines[i + 1].startsWith(fence)) {
        i++;
        cardText += "\n" + lines[i];
      }
      if (i + 1 < lines.length) {
        i++;
        cardText += "\n" + lines[i];
      }
    } else if (cardType === null && isClozeLine(line, settings)) {
      cardType = QuestionType.Cloze;
    }
  }
  if (cardType && cardText) {
    cards.push(
      new ParsedQuestion(
        cardType,
        cardText.trimEnd(),
        firstLineNo,
        lines.length - 1
      )
    );
  }
  return cards;
}

function expandQuestion(question, settings) {
  switch (question.type) {
    case QuestionType.SingleLineBasic:
      return expandSingleLine(question.rawText, settings.singleLineCardSeparator);
    case QuestionType.SingleLineReversed:
      return expandSingleLineReversed(
        question.rawText,
        settings.singleLineReversedCardSeparator
      );
    case QuestionType.MultiLineBasic:
      return expandMultiLine(
        question.rawText,
        settings.multilineCardSeparator
      );
    case QuestionType.MultiLineReversed:
      return expandMultiLineReversed(
        question.rawText,
        settings.multilineReversedCardSeparator
      );
    case QuestionType.Cloze:
      return expandCloze(question.rawText);
    default:
      return [];
  }
}

function expandSingleLine(text, separator) {
  const idx = text.indexOf(separator);
  return [
    {
      front: text.substring(0, idx),
      back: text.substring(idx + separator.length),
    },
  ];
}

function expandSingleLineReversed(text, separator) {
  const idx = text.indexOf(separator);
  const side1 = text.substring(0, idx);
  const side2 = text.substring(idx + separator.length);
  return [
    { front: side1, back: side2 },
    { front: side2, back: side1 },
  ];
}

function expandMultiLine(text, separator) {
  const lines = text.split("\n");
  const idx = findLineIndex(lines, separator);
  const side1 = lines.slice(0, idx).join("\n");
  const side2 = lines.slice(idx + 1).join("\n");
  return [{ front: side1, back: side2 }];
}

function expandMultiLineReversed(text, separator) {
  const lines = text.split("\n");
  const idx = findLineIndex(lines, separator);
  const side1 = lines.slice(0, idx).join("\n");
  const side2 = lines.slice(idx + 1).join("\n");
  return [
    { front: side1, back: side2 },
    { front: side2, back: side1 },
  ];
}

function expandCloze(text) {
  const matches = [...text.matchAll(/{{c\d*::(.*?)(::(.*?))?}}/g)];
  if (matches.length === 0) {
    return [{ front: text, back: text }];
  }
  const cards = [];
  for (let i = 0; i < matches.length; i++) {
    let front = text;
    let back = text;
    matches.forEach((match, idx) => {
      const answer = match[1];
      const hint = match[3];
      const placeholder = hint ? `[${hint}]` : "[...]";
      const replacementFront = idx === i ? placeholder : answer;
      const full = match[0];
      front = front.replace(full, replacementFront);
      back = back.replace(full, answer);
    });
    cards.push({ front, back });
  }
  return cards;
}

function findLineIndex(lines, search) {
  return lines.findIndex(
    (line) => line.trim() === search.trim()
  );
}

function hasInlineMarker(text, marker) {
  if (!marker || marker.length === 0) return false;
  const idx = text.indexOf(marker);
  if (idx === -1) return false;
  return !markerInsideCodeBlock(text, marker, idx);
}

function markerInsideCodeBlock(text, marker, markerIndex) {
  let backTicksBefore = 0,
    backTicksAfter = 0;
  for (let i = markerIndex - 1; i >= 0; i--) {
    if (text[i] === "`") backTicksBefore++;
  }
  for (let i = markerIndex + marker.length; i < text.length; i++) {
    if (text[i] === "`") backTicksAfter++;
  }
  return backTicksBefore % 2 === 1 && backTicksAfter % 2 === 1;
}

function isClozeLine(line, settings) {
  if (/{{c\d*::/i.test(line)) return true;
  if (settings.convertCurlyBracketsToClozes && /{{.*?}}/.test(line)) return true;
  if (settings.convertHighlightsToClozes && /==.+==/.test(line)) return true;
  if (settings.convertBoldTextToClozes && /\*\*.+\*\*/.test(line)) return true;
  return false;
}

function extractSchedules(text, cardCount, baseEase) {
  let matches = [...text.matchAll(/!([\d-]+),(\d+),(\d+)/g)];
  if (matches.length === 0) {
    matches = [...text.matchAll(/<!--SR:([\d-]+),(\d+),(\d+)-->/g)];
  }
  const schedules = [];
  for (let i = 0; i < cardCount; i++) {
    const match = matches[i];
    if (match) {
      schedules.push({
        due: match[1],
        interval: parseInt(match[2]),
        ease: parseInt(match[3]),
      });
    } else {
      schedules.push({ ease: baseEase });
    }
  }
  return schedules;
}

// --- Deck helpers ---
function topicPathFromTag(tag, flashcardTags) {
  if (!tag) return null;
  const clean = tag.replace(/^#/, "");
  for (const flashTag of flashcardTags || []) {
    const normalized = flashTag.replace(/^#/, "");
    if (clean === normalized) return "";
    if (clean.startsWith(normalized + "/")) {
      return clean.slice(normalized.length + 1);
    }
  }
  return null;
}

// Simple glob-like matcher for ignoring files.
function pathMatchesPattern(filePath, pattern) {
  const regex = globToRegex(pattern);
  return regex.test(filePath);
}

function globToRegex(pattern) {
  const escaped = pattern
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map(escapeRegex)
        .join("[^/]*")
    )
    .join(".*");
  return new RegExp("^" + escaped + "$");
}

function escapeRegex(str) {
  return str.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&");
}

function parseDueDate(due) {
  if (!due) return Number.POSITIVE_INFINITY;
  // SR uses YYYY-MM-DD or 0 for new cards
  if (due === "0") return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(due);
  if (Number.isNaN(parsed)) return Number.POSITIVE_INFINITY;
  return parsed;
}

function buildDeckTree(cards) {
  const root = new DeckNode("root", null);
  for (const card of cards) {
    const path = card.deck && card.deck.length > 0 ? card.deck : DEFAULT_DECK_NAME;
    const parts = path.split("/").filter((p) => p.length > 0);
    if (parts.length === 0) parts.push(DEFAULT_DECK_NAME);
    let node = root;
    for (const part of parts) {
      node = node.getOrCreateChild(part);
    }
    node.addCard(card);
  }
  root.sortSubdecks();
  return root;
}

class RenderMarkdownWrapper {
  constructor(app, plugin, notePath) {
    this.app = app;
    this.notePath = notePath;
    this.plugin = plugin;
  }
  async renderMarkdownWrapper(markdownString, containerEl, textDirection, recursiveDepth = 0) {
    if (recursiveDepth > 4) return;
    let el;
    if (textDirection === 2 /* Rtl */) {
      el = containerEl.createDiv();
      el.setAttribute("dir", "rtl");
    } else el = containerEl;
    await MarkdownRenderer.render(this.app, markdownString, el, this.notePath, this.plugin);
    el.findAll(".internal-embed, .image-embed").forEach((embedEl) => {
      const src = embedEl.getAttribute("src");
      const link = this.parseLink(src);
      if (link.target instanceof TFile && link.target.extension !== "md") {
        this.embedMediaFile(embedEl, link.target);
      }
    });
  }
  parseLink(src) {
    const linkComponentsRegex = /^(?<file>[^#^]+)?(?:#(?!\^)(?<heading>.+)|#\^(?<blockId>.+)|#)?$/;
    const matched = typeof src === "string" && src.match(linkComponentsRegex);
    if (!matched || !matched.groups) {
      return { text: src, file: null, heading: null, blockId: null, target: null };
    }
    const file = matched.groups.file || this.notePath;
    const target = this.plugin.app.metadataCache.getFirstLinkpathDest(file, this.notePath);
    return {
      text: matched ? matched[0] : src,
      file: matched ? matched.groups.file : null,
      heading: matched ? matched.groups.heading : null,
      blockId: matched ? matched.groups.blockId : null,
      target
    };
  }
  embedMediaFile(el, target) {
    el.innerText = "";
    const ext = (target.extension || "").toLowerCase();
    if (IMAGE_FORMATS.includes(ext)) {
      el.createEl(
        "img",
        {
          attr: {
            src: this.plugin.app.vault.getResourcePath(target)
          }
        },
        (img) => {
          if (el.hasAttribute("width"))
            img.setAttribute("width", el.getAttribute("width"));
          else img.setAttribute("width", "100%");
          if (el.hasAttribute("alt")) img.setAttribute("alt", el.getAttribute("alt"));
          el.addEventListener(
            "click",
            (ev) => ev.target.style.minWidth = ev.target.style.minWidth === "100%" ? null : "100%"
          );
        }
      );
      el.addClasses(["image-embed", "is-loaded"]);
    } else if (AUDIO_FORMATS.includes(ext) || VIDEO_FORMATS.includes(ext)) {
      el.createEl(
        AUDIO_FORMATS.includes(ext) ? "audio" : "video",
        {
          attr: {
            controls: "",
            src: this.plugin.app.vault.getResourcePath(target)
          }
        },
        (audio) => {
          if (el.hasAttribute("alt")) audio.setAttribute("alt", el.getAttribute("alt"));
        }
      );
      el.addClasses(["media-embed", "is-loaded"]);
    } else {
      el.innerText = target.path;
    }
  }
}

module.exports = SpacedRepetitionExplorerPlugin;
