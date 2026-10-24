'use strict';

/**
 * コンビニたんぱく質ガチャ本体。
 *
 * 【意図】ビルド環境なしでブラウザだけで動かすため、ES Modules やバンドラは使わず
 *         即時関数 1 つにまとめてグローバル汚染だけを避ける
 */
(() => {
  /**
   * 前回入力値の保存キー。
   *
   * 【注意】保存する項目や形式を変えたら末尾のバージョンを上げること。古い形式を読むと復元が崩れる
   */
  const STORAGE_KEY = 'proteinGacha.inputs.v1';

  const PRODUCTS_URL = 'products.json';

  /**
   * コース別の「体重 1kg あたり 1 日に摂るたんぱく質（g）」。
   *
   * 【意図】一般に紹介されている目安（健康維持 ≒ 1.0g、減量中は筋肉維持のため多め、
   *         筋肥大狙いは 2.0g 前後）を丸めた値を採用
   * 【注意】値を変えたら index.html のコース表示と README の表も合わせて更新すること
   */
  const COURSES = {
    bulk: { label: '肉体改造', perKg: 2.0 },
    health: { label: '健康維持', perKg: 1.0 },
    diet: { label: 'ダイエット', perKg: 1.5 },
  };

  /**
   * ガチャ 1 回 = コンビニでの 1 食分の買い物、とみなす。
   *
   * 【意図】1 日分を 1 回で買う想定だと予算・個数が現実離れするため、1 日量を 3 食で割ってプリセットする
   */
  const MEALS_PER_DAY = 3;

  /**
   * 重複 OK 時に同じ商品を入れてよい最大個数。
   *
   * 【意図】上限なしだと「ゆで卵 10 個」のような安い商品の連打セットが頻出し、ガチャとして楽しくないため
   */
  const MAX_SAME_ITEM = 3;

  /**
   * ランダム抽選の試行回数。
   *
   * 【意図】ランダム貪欲法は解の発見を保証しないため一定回数で打ち切り、
   *         その後は動的計画法（solveMaxProtein）で「本当に解がないのか」を確定させる
   */
  const RANDOM_TRIALS = 300;

  /**
   * 入力欄ごとの検証ルール。
   *
   * 【制約】予算の上限は動的計画法の配列サイズ（予算 + 1 要素 × 商品数）に直結するため、むやみに上げないこと
   */
  const FIELD_RULES = {
    weight: { label: '体重', unit: 'kg', min: 20, max: 200, integer: false, required: false },
    target: { label: '目標たんぱく質量', unit: 'g', min: 1, max: 300, integer: false, required: true },
    budget: { label: '予算', unit: '円', min: 100, max: 10000, integer: true, required: true },
  };

  const CATEGORY_EMOJI = {
    チキン: '🍗',
    卵: '🥚',
    乳製品: '🥛',
    飲料: '🥤',
    大豆: '🫘',
    主食: '🍙',
    魚介: '🐟',
    菓子: '🍫',
  };
  const DEFAULT_EMOJI = '🛒';

  const SPIN_MS = 1600;
  const SPIN_MS_REDUCED = 300;
  const CONFETTI_COLORS = ['#ff4f81', '#ffc531', '#2fc6a5', '#4aa8ff', '#a66bff'];

  /**
   * 結果画面の見出し。
   *
   * 【意図】条件を満たせば基本的に毎回成功するため、「当たり/ハズレ」のニュアンスは実態と合わない。
   *         トレーニー構文の煽り文句をランダムに出すことで、「抽選結果」を淡々と伝えるのではなく
   *         ガチャらしいドーパミンを出す
   */
  const RESULT_HYPE_LINES = [
    '💪 筋肉が切れてるよ！',
    '🔥 腹斜筋、素敵！',
    '🥶 人間冷蔵庫、爆誕！',
    '🧊 プロテイン、常温で飲める説！',
    '🍗 今日も鶏むねに救われた',
    '🦾 脳までバキバキに仕上がった',
    '🥩 肉、足りてる？もう足りてる！',
    '📈 PFCバランス、殿堂入り！',
    '🛒 コンビニ、俺のジム飯基地',
    '⚡ ちぎれる寸前のセット、見っけ！',
  ];

  function pickHypeLine() {
    return RESULT_HYPE_LINES[Math.floor(Math.random() * RESULT_HYPE_LINES.length)];
  }

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const el = {
    form: document.getElementById('gacha-form'),
    courseRadios: document.querySelectorAll('input[name="course"]'),
    weight: document.getElementById('weight'),
    courseHint: document.getElementById('course-hint'),
    target: document.getElementById('target'),
    budget: document.getElementById('budget'),
    allowDup: document.getElementById('allow-dup'),
    gachaBtn: document.getElementById('gacha-btn'),
    gachaBtnLabel: document.getElementById('gacha-btn-label'),
    reel: document.getElementById('reel'),
    reelIcon: document.getElementById('reel-icon'),
    reelName: document.getElementById('reel-name'),
    reelProtein: document.getElementById('reel-protein'),
    message: document.getElementById('message'),
    loadError: document.getElementById('load-error'),
    result: document.getElementById('result'),
    resultTitle: document.getElementById('result-title'),
    resultList: document.getElementById('result-list'),
    totalProtein: document.getElementById('total-protein'),
    totalPrice: document.getElementById('total-price'),
    overTarget: document.getElementById('over-target'),
    budgetLeft: document.getElementById('budget-left'),
    retryBtn: document.getElementById('retry-btn'),
    confetti: document.getElementById('confetti'),
  };

  let products = [];
  let isSpinning = false;

  /* ==================== 入力の検証 ==================== */

  /**
   * 全角数字・全角ピリオド・桁区切りカンマを半角の数値文字列に寄せる。
   *
   * 【意図】日本語 IME のまま入力されても弾かずに受け付けるため。
   *         input[type=number] だと全角入力が空文字扱いになり「未入力」と誤表示されるので、type=text で受けている
   */
  function normalizeNumberText(raw) {
    return raw
      .trim()
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/．/g, '.')
      .replace(/[,，]/g, '');
  }

  /**
   * 入力文字列をルールに従って数値に変換する。
   *
   * @param {string} raw 入力欄の値
   * @param {object} rule FIELD_RULES の 1 要素
   * @returns {{value: number|null}|{error: string}}
   */
  function parseNumberField(raw, rule) {
    const text = normalizeNumberText(raw);
    if (text === '') {
      return rule.required ? { error: `${rule.label}を入力してください` } : { value: null };
    }
    if (!/^\d+(\.\d+)?$/.test(text)) {
      return { error: `${rule.label}は 0 以上の数字で入力してください` };
    }
    if (rule.integer && text.includes('.')) {
      return { error: `${rule.label}は整数で入力してください` };
    }
    const value = Number(text);
    if (value < rule.min || value > rule.max) {
      return { error: `${rule.label}は ${rule.min}〜${rule.max.toLocaleString('ja-JP')}${rule.unit} の範囲で入力してください` };
    }
    return { value };
  }

  function setFieldError(name, message) {
    const input = el[name];
    document.getElementById(`${name}-error`).textContent = message;
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  /**
   * ガチャ実行に必須の「目標量」「予算」をまとめて検証する。
   *
   * 【意図】1 項目ずつ止めずに全項目のエラーを同時に出し、直す箇所を一度で把握できるようにする
   */
  function validateMainInputs() {
    const target = parseNumberField(el.target.value, FIELD_RULES.target);
    const budget = parseNumberField(el.budget.value, FIELD_RULES.budget);
    setFieldError('target', target.error || '');
    setFieldError('budget', budget.error || '');

    const firstInvalid = target.error ? el.target : budget.error ? el.budget : null;
    return {
      ok: !firstInvalid,
      firstInvalid,
      target: target.value,
      budget: budget.value,
    };
  }

  /* ==================== コースプリセット ==================== */

  function getSelectedCourse() {
    const checked = document.querySelector('input[name="course"]:checked');
    return checked ? checked.value : '';
  }

  /**
   * 選択中のコースと体重から 1 食分の目標量を計算し、目標欄に反映する。
   *
   * @param {boolean} showError 体重の不正をエラー表示するか
   *
   * 【意図】入力途中（"6" と打った瞬間など）でエラーを出すと煩わしいため、
   *         入力中は黙って計算だけ行い、欄を離れたときやコース選択時にだけエラーを出す
   * 【注意】プリセットは目標欄を上書きする。手入力した目標を残したい場合はコースを触らないこと
   */
  function applyCoursePreset(showError) {
    const course = COURSES[getSelectedCourse()];
    if (!course) {
      return;
    }

    const weight = parseNumberField(el.weight.value, FIELD_RULES.weight);
    if (weight.error || weight.value === null) {
      setFieldError('weight', showError && weight.error ? weight.error : '');
      el.courseHint.textContent = `「${course.label}」を選択中：体重を入力すると 1 食分の目標量を自動でセットします`;
      return;
    }

    setFieldError('weight', '');
    const daily = weight.value * course.perKg;
    const perMeal = Math.round(daily / MEALS_PER_DAY);
    el.target.value = String(perMeal);
    setFieldError('target', '');
    el.courseHint.textContent =
      `${course.label}：1日 ${Math.round(daily)}g（体重×${course.perKg.toFixed(1)}g）÷ ${MEALS_PER_DAY}食 ＝ 1食 ${perMeal}g をセットしました`;
    saveInputs();
  }

  /* ==================== 前回入力の保存・復元 ==================== */

  function saveInputs() {
    const data = {
      weight: el.weight.value,
      course: getSelectedCourse(),
      target: el.target.value,
      budget: el.budget.value,
      allowDup: el.allowDup.checked,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      /* 【注意】プライベートモード等で保存できなくても、ガチャ自体は動かし続ける */
    }
  }

  /**
   * 前回の入力値を復元する。
   *
   * 【注意】localStorage は利用者が手で書き換えられるため、型を確認してから反映する
   */
  function restoreInputs() {
    let data;
    try {
      data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch (e) {
      return;
    }
    if (!data || typeof data !== 'object') {
      return;
    }

    if (typeof data.weight === 'string') el.weight.value = data.weight;
    if (typeof data.target === 'string') el.target.value = data.target;
    if (typeof data.budget === 'string') el.budget.value = data.budget;
    if (typeof data.allowDup === 'boolean') el.allowDup.checked = data.allowDup;
    el.courseRadios.forEach((radio) => {
      radio.checked = radio.value === data.course;
    });
  }

  /* ==================== 商品データ ==================== */

  function isValidProduct(p) {
    return (
      p !== null &&
      typeof p === 'object' &&
      Number.isInteger(p.id) &&
      typeof p.name === 'string' &&
      Number.isInteger(p.price) &&
      p.price > 0 &&
      typeof p.protein === 'number' &&
      p.protein >= 0 &&
      typeof p.category === 'string'
    );
  }

  /**
   * products.json を読み込み、形式が正しい商品だけを返す。
   *
   * 【制約】fetch は file:// では動かないブラウザが多いため、ローカルサーバー経由での起動が前提
   * 【注意】JSON の 1 件が壊れていても全体を止めず、その商品だけ除外する
   */
  async function loadProducts() {
    const res = await fetch(PRODUCTS_URL, { cache: 'no-cache' });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const json = await res.json();
    if (!Array.isArray(json)) {
      throw new Error('商品データが配列ではありません');
    }
    return json.filter(isValidProduct);
  }

  function showLoadError() {
    el.loadError.textContent =
      location.protocol === 'file:'
        ? '商品データを読み込めませんでした。ファイルを直接開くとブラウザの制限で読み込めないため、README の手順でローカルサーバーから開いてください。'
        : '商品データ（products.json）を読み込めませんでした。ファイルの配置と JSON の書式を確認してください。';
    el.loadError.hidden = false;
    el.gachaBtn.disabled = true;
  }

  /* ==================== 抽選ロジック ==================== */

  /**
   * 抽選の母集団を作る。重複 OK なら同じ商品を MAX_SAME_ITEM 個ぶん並べる。
   *
   * 【意図】「同じ商品を最大 n 個」を、商品のコピーを n 個置くことで表現する。
   *         こうするとランダム抽選も動的計画法も「各要素を 0 or 1 個選ぶ」問題として同じ形で扱える
   * 【制約】たんぱく質は 0.1g 単位の整数（protein10）に変換する。小数のまま足すと
   *         0.1 + 0.2 !== 0.3 のような誤差で「目標ちょうど」の判定がずれるため
   */
  function buildPool(list, allowDup) {
    const copies = allowDup ? MAX_SAME_ITEM : 1;
    const pool = [];
    list.forEach((product) => {
      for (let i = 0; i < copies; i++) {
        pool.push({ product, protein10: Math.round(product.protein * 10) });
      }
    });
    return pool;
  }

  function shuffle(array) {
    const a = array.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /**
   * ランダムな順番で商品を見ていき、予算に収まるものを入れて目標到達を目指す。
   *
   * 【意図】毎回シャッフルするので結果に偏りが出にくく、ガチャらしい意外な組み合わせが出る
   * 【注意】目標に届いた時点で打ち切るため、予算を使い切るとは限らない
   *
   * @returns {Array|null} 達成したセット。届かなければ null
   */
  function tryRandomSet(pool, target10, budget) {
    const picked = [];
    let spent = 0;
    let protein10 = 0;
    for (const item of shuffle(pool)) {
      if (spent + item.product.price > budget) {
        continue;
      }
      picked.push(item);
      spent += item.product.price;
      protein10 += item.protein10;
      if (protein10 >= target10) {
        return picked;
      }
    }
    return null;
  }

  /**
   * 予算内で集められる最大たんぱく質量と、そのセットを求める（0/1 ナップサック問題）。
   *
   * 【意図】ランダム抽選が外れ続けたとき、「運が悪かった」のか「条件的に不可能」なのかを
   *         確実に区別するために使う。不可能なら最大値を示して条件の見直しを促せる
   * 【制約】計算量は O(商品数 × 予算)。予算上限 10,000 円・母集団 66 件で約 66 万ステップ
   */
  function solveMaxProtein(pool, budget) {
    const best = new Int32Array(budget + 1);
    const taken = pool.map(() => new Uint8Array(budget + 1));

    pool.forEach((item, i) => {
      const price = item.product.price;
      for (let b = budget; b >= price; b--) {
        const candidate = best[b - price] + item.protein10;
        if (candidate > best[b]) {
          best[b] = candidate;
          taken[i][b] = 1;
        }
      }
    });

    /* 【意図】後ろの商品から「その予算で選んだか」を辿ると、最大値を作ったセットを復元できる */
    const items = [];
    let b = budget;
    for (let i = pool.length - 1; i >= 0; i--) {
      if (taken[i][b]) {
        items.push(pool[i]);
        b -= pool[i].product.price;
      }
    }
    return { protein10: best[budget], items };
  }

  /**
   * 条件に合うセットを 1 つ抽選する。
   *
   * @returns {{ok: true, items: Array}|{ok: false, reason: string, cheapest?: number, maxProtein10?: number}}
   */
  function drawSet(list, targetG, budget, allowDup) {
    const target10 = Math.round(targetG * 10);
    const cheapest = Math.min(...list.map((p) => p.price));
    if (cheapest > budget) {
      return { ok: false, reason: 'NO_AFFORDABLE', cheapest };
    }

    const pool = buildPool(list, allowDup);
    for (let i = 0; i < RANDOM_TRIALS; i++) {
      const items = tryRandomSet(pool, target10, budget);
      if (items) {
        return { ok: true, items };
      }
    }

    const best = solveMaxProtein(pool, budget);
    if (best.protein10 >= target10) {
      return { ok: true, items: best.items };
    }
    return { ok: false, reason: 'TARGET_UNREACHABLE', maxProtein10: best.protein10 };
  }

  /* ==================== 表示 ==================== */

  const formatYen = (n) => Math.round(n).toLocaleString('ja-JP');
  const formatGram = (n) => n.toFixed(1);
  const emojiOf = (product) => CATEGORY_EMOJI[product.category] || DEFAULT_EMOJI;

  /**
   * 同じ商品をまとめて「× 個数」表示にする。
   *
   * 【意図】重複 OK 時に同じカードが縦に並ぶと読みづらいため 1 枚にまとめ、たんぱく質の多い順に並べる
   */
  function groupItems(items) {
    const map = new Map();
    items.forEach(({ product }) => {
      const g = map.get(product.id) || { product, count: 0 };
      g.count += 1;
      map.set(product.id, g);
    });
    return [...map.values()].sort((a, b) => b.product.protein * b.count - a.product.protein * a.count);
  }

  /**
   * 結果カードを 1 枚組み立てる。
   *
   * 【注意】商品名は JSON 由来の文字列なので innerHTML に入れず textContent で差し込む（XSS 対策）
   */
  function createCard(group, index) {
    const { product, count } = group;
    const li = document.createElement('li');
    li.className = 'card';
    li.style.setProperty('--i', String(index));

    const icon = document.createElement('span');
    icon.className = 'card__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = emojiOf(product);

    const body = document.createElement('div');
    body.className = 'card__body';
    const category = document.createElement('span');
    category.className = 'card__category';
    category.textContent = product.category;
    const name = document.createElement('p');
    name.className = 'card__name';
    name.textContent = product.name;
    if (count > 1) {
      const badge = document.createElement('span');
      badge.className = 'card__count';
      badge.textContent = `×${count}`;
      name.append(badge);
    }
    body.append(category, name);

    const meta = document.createElement('div');
    meta.className = 'card__meta';
    const protein = document.createElement('span');
    protein.className = 'card__protein';
    protein.textContent = `${formatGram(product.protein * count)}g`;
    const price = document.createElement('span');
    price.className = 'card__price';
    price.textContent = `${formatYen(product.price * count)}円`;
    meta.append(protein, price);
    if (count > 1) {
      const unit = document.createElement('span');
      unit.className = 'card__unit';
      unit.textContent = `${formatYen(product.price)}円 × ${count}`;
      meta.append(unit);
    }

    li.append(icon, body, meta);
    return li;
  }

  function animateCount(node, to, format) {
    if (reduceMotion.matches) {
      node.textContent = format(to);
      return;
    }
    const duration = 700;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      node.textContent = format(to * eased);
      if (t < 1) {
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  }

  function burstConfetti() {
    if (reduceMotion.matches) {
      return;
    }
    const pieces = [];
    for (let i = 0; i < 36; i++) {
      const piece = document.createElement('span');
      piece.className = 'confetti__piece';
      piece.style.setProperty('--x', `${Math.random() * 100}vw`);
      piece.style.setProperty('--c', CONFETTI_COLORS[i % CONFETTI_COLORS.length]);
      piece.style.setProperty('--d', `${900 + Math.random() * 700}ms`);
      piece.style.setProperty('--delay', `${Math.random() * 200}ms`);
      piece.style.setProperty('--drift', `${(Math.random() - 0.5) * 160}px`);
      piece.style.setProperty('--r', `${Math.random() * 720 - 360}deg`);
      pieces.push(piece);
    }
    el.confetti.append(...pieces);
    setTimeout(() => pieces.forEach((p) => p.remove()), 1900);
  }

  function renderResult(items, target10, budget) {
    const groups = groupItems(items);
    const totalPrice = items.reduce((sum, item) => sum + item.product.price, 0);
    const totalProtein10 = items.reduce((sum, item) => sum + item.protein10, 0);

    el.resultTitle.textContent = pickHypeLine();
    el.resultList.replaceChildren(...groups.map(createCard));
    el.overTarget.textContent = `目標 ${formatGram(target10 / 10)}g 達成！（+${formatGram((totalProtein10 - target10) / 10)}g）`;
    el.budgetLeft.textContent = `予算残り ${formatYen(budget - totalPrice)}円`;

    /* 【注意】同じ要素に同じアニメーションを再適用するには、クラスを外して再描画（reflow）させる必要がある */
    el.result.classList.remove('is-revealed');
    el.result.hidden = false;
    void el.result.offsetWidth;
    el.result.classList.add('is-revealed');

    animateCount(el.totalProtein, totalProtein10 / 10, formatGram);
    animateCount(el.totalPrice, totalPrice, formatYen);
    burstConfetti();
    el.result.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
  }

  function renderFailure(outcome, target10, budget, allowDup) {
    const title = document.createElement('strong');
    title.className = 'alert__title';
    const detail = document.createElement('p');
    const tips = document.createElement('ul');
    const addTip = (text) => {
      const li = document.createElement('li');
      li.textContent = text;
      tips.append(li);
    };

    if (outcome.reason === 'NO_AFFORDABLE') {
      title.textContent = '😢 予算内で買える商品がありません';
      detail.textContent = `いちばん安い商品でも ${formatYen(outcome.cheapest)}円 です。`;
      addTip(`予算を ${formatYen(outcome.cheapest)}円 以上にしてみてください`);
    } else {
      title.textContent = '😢 条件に合う組み合わせが見つかりませんでした';
      detail.textContent =
        `予算 ${formatYen(budget)}円 で集められるたんぱく質は最大 ${formatGram(outcome.maxProtein10 / 10)}g です（目標 ${formatGram(target10 / 10)}g）。`;
      addTip('予算を増やす');
      addTip(`目標たんぱく質量を ${formatGram(outcome.maxProtein10 / 10)}g 以下にする`);
      if (!allowDup) {
        addTip('「重複OK」にチェックを入れる');
      }
    }

    el.message.replaceChildren(title, detail, tips);
    el.message.hidden = false;
    el.message.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'center' });
  }

  /* ==================== 抽選演出 ==================== */

  /**
   * 商品名がパラパラ切り替わるスロット演出を再生する。
   *
   * 【意図】切り替え間隔を徐々に伸ばして「止まりそうで止まらない」減速感を出し、期待感を高める
   * 【注意】抽選結果は演出前に確定済み。演出は見た目だけなので、タップで即スキップできるようにして操作を妨げない
   */
  function playSpin() {
    return new Promise((resolve) => {
      const total = reduceMotion.matches ? SPIN_MS_REDUCED : SPIN_MS;
      const start = performance.now();
      let timer = 0;
      let finished = false;

      const finish = () => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);
        el.reel.removeEventListener('click', finish);
        el.reel.classList.remove('is-spinning');
        el.reel.hidden = true;
        resolve();
      };

      const tick = () => {
        const elapsed = performance.now() - start;
        if (elapsed >= total) {
          finish();
          return;
        }
        const product = products[Math.floor(Math.random() * products.length)];
        el.reelIcon.textContent = emojiOf(product);
        el.reelName.textContent = product.name;
        el.reelProtein.textContent = `たんぱく質 ${formatGram(Math.random() * 99)}g`;

        /* 【意図】再描画のたびに切り替えアニメーションを最初から流し直す */
        el.reel.classList.remove('is-spinning');
        void el.reel.offsetWidth;
        el.reel.classList.add('is-spinning');

        const progress = elapsed / total;
        timer = setTimeout(tick, 45 + progress * progress * 260);
      };

      el.reel.hidden = false;
      el.reel.addEventListener('click', finish);
      el.reel.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'center' });
      tick();
    });
  }

  function setBusy(busy) {
    isSpinning = busy;
    el.gachaBtn.disabled = busy;
    el.retryBtn.disabled = busy;
    el.gachaBtn.classList.toggle('is-busy', busy);
    el.gachaBtnLabel.textContent = busy ? '抽選中…' : 'ガチャを回す！';
  }

  /* ==================== メイン処理 ==================== */

  async function handleGacha(event) {
    if (event) {
      event.preventDefault();
    }
    if (isSpinning || products.length === 0) {
      return;
    }

    const input = validateMainInputs();
    if (!input.ok) {
      input.firstInvalid.focus();
      return;
    }
    saveInputs();

    const allowDup = el.allowDup.checked;
    const target10 = Math.round(input.target * 10);
    const outcome = drawSet(products, input.target, input.budget, allowDup);

    setBusy(true);
    el.result.hidden = true;
    el.message.hidden = true;
    await playSpin();
    setBusy(false);

    if (outcome.ok) {
      renderResult(outcome.items, target10, input.budget);
    } else {
      renderFailure(outcome, target10, input.budget, allowDup);
    }
  }

  /**
   * 目標量・予算欄のイベント設定。
   *
   * 【意図】打ち直している最中はエラーを消して邪魔せず、欄を離れた時点で改めて検証する
   */
  function bindMainField(name) {
    const input = el[name];
    input.addEventListener('input', () => {
      setFieldError(name, '');
      saveInputs();
    });
    input.addEventListener('blur', () => {
      if (input.value.trim() === '') {
        return;
      }
      const result = parseNumberField(input.value, FIELD_RULES[name]);
      setFieldError(name, result.error || '');
    });
  }

  function bindEvents() {
    el.form.addEventListener('submit', handleGacha);
    el.retryBtn.addEventListener('click', handleGacha);
    el.courseRadios.forEach((radio) => {
      radio.addEventListener('change', () => {
        applyCoursePreset(true);
        saveInputs();
      });
    });
    el.weight.addEventListener('input', () => {
      applyCoursePreset(false);
      saveInputs();
    });
    el.weight.addEventListener('blur', () => applyCoursePreset(true));
    el.allowDup.addEventListener('change', saveInputs);
    bindMainField('target');
    bindMainField('budget');
  }

  async function init() {
    restoreInputs();
    bindEvents();
    try {
      products = await loadProducts();
      if (products.length === 0) {
        throw new Error('有効な商品がありません');
      }
      el.gachaBtn.disabled = false;
    } catch (err) {
      console.error(err);
      showLoadError();
    }
  }

  init();
})();
