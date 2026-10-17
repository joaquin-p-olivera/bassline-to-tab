// Interactive tablature: wraps bars to the available width (no horizontal
// scrolling), highlights the sixteenth being played and seeks on click.

const MIN_FONT_PX = 9;

function cellWidth(frets) {
  return frets.some((fret) => fret >= 10) ? 3 : 2;
}

/// Width of one monospace character in the container's font, in pixels.
function measureCharWidth(container) {
  const probe = document.createElement("span");
  probe.textContent = "0".repeat(100);
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
  container.append(probe);
  const width = probe.getBoundingClientRect().width / 100;
  probe.remove();
  return width || 8;
}

export class TabView {
  constructor(container) {
    this.container = container;
    this.result = null;
    this.lines = [];
    this.activeLine = null;
    this.follow = true;
    this.onSeek = null;
    this.baseFontPx = parseFloat(getComputedStyle(container).fontSize) || 14;
    new ResizeObserver(() => this.#scheduleLayout()).observe(container);
  }

  /// Shows a transcription returned by the worker.
  setTranscription(result) {
    this.result = result;
    this.#prepareBars();
    this.layout();
  }

  /// Moves the cursor to `seconds` of audio.
  setTime(seconds) {
    this.lastTime = seconds;
    if (!this.result || !this.lines.length) return;
    const step = Math.floor((seconds - this.result.gridOrigin) / this.stepSeconds);
    const bar = Math.floor(step / this.stepsPerBar);
    const line = this.lines.find((l) => bar >= l.firstBar && bar < l.firstBar + l.barCount);
    if (step < 0 || !line) {
      this.#hideCursor();
      return;
    }
    const offset = line.prefix + line.barOffsets[bar - line.firstBar] + (step % this.stepsPerBar) * this.cells[bar];
    line.cursor.style.left = `${offset}ch`;
    line.cursor.style.width = `${this.cells[bar]}ch`;
    if (this.activeLine !== line) {
      this.#hideCursor();
      line.cursor.hidden = false;
      this.activeLine = line;
      if (this.follow) line.element.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  layout() {
    if (!this.result) return;
    const { stringLabels } = this.result;
    const labelWidth = Math.max(...stringLabels.map((label) => label.length));
    const prefix = labelWidth + 1;
    const widestBar = Math.max(...this.cells) * this.stepsPerBar + 1;

    // Shrink the font if not even one bar fits (narrow phones).
    this.container.style.fontSize = "";
    let charWidth = measureCharWidth(this.container);
    let available = Math.floor(this.container.clientWidth / charWidth) - 1;
    if (available < prefix + widestBar) {
      const fontPx = Math.max(MIN_FONT_PX, (this.baseFontPx * available) / (prefix + widestBar));
      this.container.style.fontSize = `${fontPx}px`;
      charWidth = measureCharWidth(this.container);
      available = Math.floor(this.container.clientWidth / charWidth) - 1;
    }

    const lines = [];
    let current = null;
    for (let bar = 0; bar < this.barCount; bar++) {
      const width = this.cells[bar] * this.stepsPerBar + 1;
      if (!current || (current.width + width > available && current.barCount > 0)) {
        current = { firstBar: bar, barCount: 0, width: prefix, prefix, barOffsets: [] };
        lines.push(current);
      }
      current.barOffsets.push(current.width - prefix);
      current.barCount += 1;
      current.width += width;
    }

    for (const line of lines) {
      line.element = this.#renderLine(line, prefix, labelWidth);
      line.cursor = line.element.querySelector(".tab-cursor");
    }
    this.container.replaceChildren(...lines.map((line) => line.element));
    this.lines = lines;
    this.activeLine = null;
  }

  #prepareBars() {
    const { events, stepsPerBar, stepsPerBeat, bpm } = this.result;
    this.stepsPerBar = stepsPerBar;
    this.stepSeconds = 60 / bpm / stepsPerBeat;
    this.barCount = events.length ? Math.floor(events[events.length - 1].step / stepsPerBar) + 1 : 1;
    this.byStep = new Map(events.map((event) => [event.step, event]));
    this.cells = Array.from({ length: this.barCount }, (_, bar) => {
      const frets = events.filter((e) => Math.floor(e.step / stepsPerBar) === bar).map((e) => e.fret);
      return cellWidth(frets);
    });
  }

  #renderLine(line, prefix, labelWidth) {
    const { stringLabels } = this.result;
    const rows = [];
    let numbers = " ".repeat(prefix);
    for (let i = 0; i < line.barCount; i++) {
      const bar = line.firstBar + i;
      numbers += String(bar + 1).padEnd(this.cells[bar] * this.stepsPerBar + 1);
    }
    rows.push(numbers.trimEnd());
    for (let string = stringLabels.length - 1; string >= 0; string--) {
      let row = `${stringLabels[string].padEnd(labelWidth)}|`;
      for (let i = 0; i < line.barCount; i++) {
        const bar = line.firstBar + i;
        for (let s = bar * this.stepsPerBar; s < (bar + 1) * this.stepsPerBar; s++) {
          const event = this.byStep.get(s);
          const cell = event && event.string === string ? String(event.fret) : "";
          row += cell.padEnd(this.cells[bar], "-");
        }
        row += "|";
      }
      rows.push(row);
    }

    const element = document.createElement("div");
    element.className = "tab-line relative cursor-pointer";
    element.dataset.firstBar = String(line.firstBar);
    const pre = document.createElement("pre");
    pre.className = "leading-tight";
    pre.textContent = rows.join("\n");
    const cursor = document.createElement("div");
    cursor.className = "tab-cursor pointer-events-none absolute rounded-sm bg-amber-500/40";
    cursor.style.top = "1.25em";
    cursor.style.bottom = "0";
    cursor.hidden = true;
    element.append(pre, cursor);
    element.addEventListener("click", (event) => this.#seekFromClick(line, element, event));
    return element;
  }

  #seekFromClick(line, element, event) {
    if (!this.onSeek) return;
    const charWidth = measureCharWidth(element);
    const column = (event.clientX - element.getBoundingClientRect().left) / charWidth - line.prefix;
    let barIndex = line.barOffsets.findLastIndex((offset) => offset <= column);
    if (barIndex < 0) barIndex = 0;
    const bar = line.firstBar + barIndex;
    const within = Math.max(0, column - line.barOffsets[barIndex]);
    const stepInBar = Math.min(this.stepsPerBar - 1, Math.floor(within / this.cells[bar]));
    const step = bar * this.stepsPerBar + stepInBar;
    this.onSeek(this.result.gridOrigin + step * this.stepSeconds);
  }

  #hideCursor() {
    if (this.activeLine) this.activeLine.cursor.hidden = true;
    this.activeLine = null;
  }

  #scheduleLayout() {
    clearTimeout(this.layoutTimer);
    this.layoutTimer = setTimeout(() => {
      const time = this.lastTime;
      this.layout();
      if (time !== undefined) this.setTime(time);
    }, 100);
  }
}
