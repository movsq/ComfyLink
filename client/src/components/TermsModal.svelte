<script>
  import { acceptTos } from '../lib/api.js';

  let { token, onAccepted, onDeclined } = $props();

  let loading = $state(false);
  let error = $state('');
  let scrolledToBottom = $state(false);
  let lang = $state('en');
  let scrollEl;

  $effect(() => {
    if (!scrollEl) return;
    // Reset to top on mount (guards against browser scroll restoration).
    // Also check if content is short enough to fit without scrolling.
    scrollEl.scrollTop = 0;
    scrolledToBottom = scrollEl.scrollHeight <= scrollEl.clientHeight + 4;
  });

  function handleScroll(e) {
    const el = e.currentTarget;
    scrolledToBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  }

  async function handleAccept() {
    loading = true;
    error = '';
    try {
      await acceptTos(token);
      onAccepted();
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
<div class="backdrop" role="dialog" aria-modal="true" tabindex="-1">
  <div class="panel">
    <div class="handle"></div>

    <div class="header">
      <span class="title">{lang === 'en' ? 'TERMS OF SERVICE' : 'PODMÍNKY UŽÍVÁNÍ'}</span>
      <div class="lang-toggle">
        <button class="lang-btn" class:active={lang === 'en'} onclick={() => { lang = 'en'; scrolledToBottom = false; scrollEl?.scrollTo(0, 0); }}>EN</button>
        <span class="lang-sep">|</span>
        <button class="lang-btn" class:active={lang === 'cz'} onclick={() => { lang = 'cz'; scrolledToBottom = false; scrollEl?.scrollTo(0, 0); }}>CZ</button>
      </div>
    </div>

    <div class="terms-scroll" onscroll={handleScroll} bind:this={scrollEl}>
      {#if lang === 'en'}
        <p class="section-heading">1. Service Description</p>
        <p class="terms-text">
          ComfyLink ("Service") is a personal relay that routes end-to-end encrypted
          AI image-generation requests between your browser and a remote PC running
          ComfyUI. The relay server processes only opaque ciphertext; it has no access
          to your prompts, images, or results.
        </p>

        <p class="section-heading">2. Operator</p>
        <p class="terms-text">
          The Service is operated by an individual natural person
          ("Operator") in accordance with the laws of the Czech Republic.
          Contact information is available upon request via the admin account.
        </p>

        <p class="section-heading">3. Acceptance &amp; Eligibility</p>
        <p class="terms-text">
          By clicking <strong>"I AGREE"</strong> you enter into a binding agreement
          pursuant to § 1724 et seq. of Act No. 89/2012 Coll. (Czech Civil Code).
          You confirm that you are at least 18 years of age or have legal capacity
          to enter into this agreement.
        </p>

        <p class="section-heading">4. Permitted Use</p>
        <p class="terms-text">
          You may use the Service solely for lawful purposes. You agree not to
          generate, transmit, or store content that is illegal under Czech law or
          the law of your jurisdiction, including but not limited to content that
          violates Regulation (EU) 2024/1689 (AI Act), depicts child sexual abuse
          material, constitutes hate speech under § 355 of Act No. 40/2009 Coll.
          (Czech Criminal Code), or infringes third-party intellectual property rights.
        </p>

        <p class="section-heading">5. User Accounts &amp; Quotas</p>
        <p class="terms-text">
          Access requires Google OAuth or an invite code. Per-user generation quotas
          may be set by an admin and can be modified or revoked at any time without
          prior notice. You are responsible for all activity under your account.
        </p>

        <p class="section-heading">6. Privacy &amp; Data Processing</p>
        <p class="terms-text">
          The Operator processes personal data in accordance with Regulation (EU)
          2016/679 (GDPR) as supplemented by Act No. 110/2019 Coll. (Czech Data
          Protection Act). Data collected: Google account identifier (sub), email
          address, display name, and profile picture — solely for authentication
          and access control. Your prompts and generated images are end-to-end
          encrypted; the server has no technical means to access them. Vault data
          (encrypted blobs) is stored on the server but is readable only by you.
          You may delete your vault and all stored results at any time via the app.
        </p>

        <p class="section-heading">7. Data Retention &amp; Deletion</p>
        <p class="terms-text">
          Account data is retained for the duration of the service. You may request
          complete deletion of your account data by contacting the Operator. Upon
          deletion, all vault keys and encrypted results are permanently destroyed.
        </p>

        <p class="section-heading">8. Disclaimer of Warranties</p>
        <p class="terms-text">
          The Service is provided <strong>"as is"</strong> without warranty of any
          kind. The Operator does not guarantee availability, uptime, or fitness
          for any particular purpose. To the maximum extent permitted by Czech law,
          the Operator shall not be liable for any indirect, incidental, or
          consequential damages arising from your use of the Service.
        </p>

        <p class="section-heading">9. Termination</p>
        <p class="terms-text">
          The Operator may suspend or terminate your access at any time for any
          reason, including violation of these terms. You may stop using the
          Service at any time.
        </p>

        <p class="section-heading">10. Governing Law</p>
        <p class="terms-text">
          These terms are governed by the laws of the Czech Republic. Any disputes
          shall be resolved by the competent courts of the Czech Republic.
        </p>

        <p class="section-heading">11. Amendments</p>
        <p class="terms-text">
          The Operator may amend these terms at any time. Material changes will be
          communicated via the app. Continued use after notification constitutes
          acceptance (§ 1752 Czech Civil Code).
        </p>

      {:else}
        <p class="section-heading">1. Popis služby</p>
        <p class="terms-text">
          ComfyLink („Služba") je osobní přenosový server, který směruje end-to-end
          šifrované požadavky na generování obrázků pomocí AI mezi vaším prohlížečem
          a vzdáleným počítačem s ComfyUI. Přenosový server zpracovává pouze
          nečitelný šifertext; nemá přístup k vašim promptům, obrázkům ani výsledkům.
        </p>

        <p class="section-heading">2. Provozovatel</p>
        <p class="terms-text">
          Službu provozuje fyzická osoba – nepodnikatel („Provozovatel")
          v souladu s právními předpisy České republiky.
          Kontaktní údaje jsou k dispozici na vyžádání prostřednictvím účtu správce.
        </p>

        <p class="section-heading">3. Souhlas a způsobilost</p>
        <p class="terms-text">
          Kliknutím na <strong>„SOUHLASÍM"</strong> uzavíráte závaznou smlouvu
          podle § 1724 a násl. zákona č. 89/2012 Sb. (občanský zákoník).
          Potvrzujete, že jste dosáhli věku 18 let nebo máte plnou způsobilost
          k právním úkonům nutnou k uzavření této smlouvy.
        </p>

        <p class="section-heading">4. Povolené užívání</p>
        <p class="terms-text">
          Službu smíte využívat výhradně k zákonným účelům. Souhlasíte, že nebudete
          generovat, přenášet ani ukládat obsah, který je nezákonný podle českého
          práva nebo práva vaší jurisdikce, včetně obsahu porušujícího Nařízení
          (EU) 2024/1689 (zákon o AI), zobrazujícího dětskou pornografii, naplňujícího
          znaky trestného činu hanobení národa, rasy, etnické nebo jiné skupiny osob
          dle § 355 zákona č. 40/2009 Sb. (trestní zákoník), nebo porušujícího
          práva duševního vlastnictví třetích stran.
        </p>

        <p class="section-heading">5. Uživatelské účty a kvóty</p>
        <p class="terms-text">
          Přístup ke Službě vyžaduje přihlášení přes Google OAuth nebo použití
          pozvánkového kódu. Kvóty generování na uživatele může správce kdykoli
          nastavit, upravit nebo zrušit bez předchozího upozornění. Za veškerou
          aktivitu pod vaším účtem nesete plnou odpovědnost.
        </p>

        <p class="section-heading">6. Ochrana osobních údajů</p>
        <p class="terms-text">
          Provozovatel zpracovává osobní údaje v souladu s Nařízením (EU) 2016/679
          (GDPR) ve spojení se zákonem č. 110/2019 Sb. (zákon o zpracování osobních
          údajů). Shromažďované údaje: identifikátor účtu Google (sub), e-mailová
          adresa, zobrazované jméno a profilový obrázek – výhradně za účelem
          ověřování totožnosti a řízení přístupu. Vaše prompty a vygenerované obrázky
          jsou end-to-end šifrovány; server k nim nemá technický přístup. Data trezoru
          (šifrované bloby) jsou uložena na serveru, ale přečíst je můžete pouze vy.
          Trezor a všechny uložené výsledky můžete kdykoli smazat přímo v aplikaci.
        </p>

        <p class="section-heading">7. Uchovávání a mazání dat</p>
        <p class="terms-text">
          Data účtu jsou uchovávána po dobu existence Služby. Úplné smazání
          svých dat můžete kdykoli vyžádat kontaktováním Provozovatele.
          Po smazání jsou všechny klíče trezoru a šifrované výsledky trvale zničeny.
        </p>

        <p class="section-heading">8. Vyloučení záruk</p>
        <p class="terms-text">
          Služba je poskytována <strong>„tak, jak je"</strong>, bez jakékoli záruky.
          Provozovatel nezaručuje dostupnost, nepřetržitý provoz ani vhodnost
          pro konkrétní účel. V maximálním rozsahu povoleném českým právem
          nenese Provozovatel odpovědnost za nepřímé, náhodné ani následné škody
          vzniklé v souvislosti s využíváním Služby.
        </p>

        <p class="section-heading">9. Ukončení přístupu</p>
        <p class="terms-text">
          Provozovatel může váš přístup kdykoli pozastavit nebo ukončit z jakéhokoli
          důvodu, včetně porušení těchto podmínek. Využívání Služby můžete kdykoli
          ukončit i vy.
        </p>

        <p class="section-heading">10. Rozhodné právo</p>
        <p class="terms-text">
          Tyto podmínky se řídí právem České republiky. Veškeré spory budou
          řešeny u příslušných soudů České republiky.
        </p>

        <p class="section-heading">11. Změny podmínek</p>
        <p class="terms-text">
          Provozovatel může tyto podmínky kdykoli změnit. O podstatných změnách
          budete informováni prostřednictvím aplikace. Pokračování v užívání
          Služby po oznámení změn představuje souhlas s novými podmínkami
          (§ 1752 občanského zákoníku).
        </p>
      {/if}
    </div>

    {#if error}
      <p class="error">{error}</p>
    {/if}

    <div class="actions">
      <button class="btn-primary" onclick={handleAccept} disabled={loading || !scrolledToBottom}>
        {loading ? (lang === 'en' ? 'SAVING…' : 'UKLÁDÁM…') : (lang === 'en' ? 'I UNDERSTAND AND AGREE' : 'ROZUMÍM A SOUHLASÍM')}
      </button>
      <button class="btn-secondary" onclick={onDeclined} disabled={loading}>
        {lang === 'en' ? 'DECLINE' : 'ODMÍTNOUT'}
      </button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 120;
    background: rgba(0, 0, 0, 0.82);
    backdrop-filter: blur(10px);
    display: flex;
    align-items: flex-end;
    justify-content: center;
    animation: fade-in 0.22s ease both;
  }
  @media (min-width: 480px) {
    .backdrop { align-items: center; padding: 1.5rem; }
  }
  @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }

  .panel {
    width: 100%;
    max-width: 440px;
    background: rgba(14, 14, 18, 0.96);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 1.25rem 1.25rem 0 0;
    padding: 0 1.75rem 1.75rem;
    backdrop-filter: blur(24px);
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-height: 90dvh;
    animation: sheet-up 0.28s cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  @media (min-width: 480px) {
    .panel {
      border-radius: 1.25rem;
      max-height: 80vh;
      animation: panel-in 0.24s cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    @keyframes panel-in {
      from { transform: scale(0.96) translateY(-6px); opacity: 0; }
      to   { transform: scale(1)    translateY(0);    opacity: 1; }
    }
  }
  @keyframes sheet-up {
    from { transform: translateY(100%); opacity: 0; }
    to   { transform: translateY(0);    opacity: 1; }
  }

  .handle {
    width: 2.5rem; height: 3px; border-radius: 9999px;
    background: rgba(255, 255, 255, 0.12);
    align-self: center; margin: 1rem 0 0.5rem; flex-shrink: 0;
  }
  @media (min-width: 480px) { .handle { display: none; } }

  .header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0.25rem 0 0;
  }
  .title {
    font-family: 'DM Mono', monospace;
    font-size: 0.65rem; letter-spacing: 0.22em; color: #527490;
  }

  .lang-toggle {
    display: flex; align-items: center; gap: 0.3rem;
  }
  .lang-sep {
    font-family: 'DM Mono', monospace;
    font-size: 0.6rem; color: rgba(255,255,255,0.15);
  }
  .lang-btn {
    background: none; border: none; padding: 0.1rem 0.2rem;
    font-family: 'DM Mono', monospace;
    font-size: 0.6rem; letter-spacing: 0.12em;
    color: rgba(255,255,255,0.3);
    cursor: pointer;
    transition: color 0.15s;
  }
  .lang-btn:hover { color: rgba(255,255,255,0.6); }
  .lang-btn.active { color: #527490; }

  .terms-scroll {
    overflow-y: auto;
    max-height: 50dvh;
    padding-right: 0.5rem;
    scrollbar-width: thin;
    scrollbar-color: rgba(82, 116, 144, 0.25) transparent;
  }

  .section-heading {
    font-family: 'DM Mono', monospace;
    font-size: 0.68rem; font-weight: 600;
    letter-spacing: 0.06em;
    color: #c2ccd5;
    margin: 1rem 0 0.25rem;
  }
  .section-heading:first-child { margin-top: 0; }

  .terms-text {
    font-family: 'DM Mono', monospace;
    font-size: 0.68rem; color: #8b96a6;
    line-height: 1.65; margin: 0 0 0.25rem;
  }
  .terms-text strong { color: #c2ccd5; }

  .error {
    font-family: 'DM Mono', monospace;
    font-size: 0.7rem; color: #d97a5a; margin: 0;
    text-align: center;
  }

  .actions {
    display: flex; flex-direction: column; gap: 0.6rem;
    padding-top: 0.25rem;
  }

  .btn-primary {
    padding: 0.8rem; border: none; border-radius: 3rem;
    background: #527490; color: #09090b;
    font-family: 'DM Mono', monospace;
    font-size: 0.72rem; font-weight: 500; letter-spacing: 0.14em;
    cursor: pointer;
    transition: transform 0.12s, filter 0.12s, background 0.2s;
  }
  .btn-primary:hover:not(:disabled) { background: #7d9db6; }
  .btn-primary:active:not(:disabled) { transform: scale(0.96); filter: brightness(0.85); }
  .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-secondary {
    padding: 0.65rem 0.875rem;
    background: rgba(255, 255, 255, 0.06); color: #c2ccd5;
    border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 3rem;
    font-family: 'DM Mono', monospace;
    font-size: 0.68rem; letter-spacing: 0.08em;
    cursor: pointer; text-align: center;
    transition: transform 0.12s, background 0.2s, color 0.2s;
  }
  .btn-secondary:hover { background: rgba(255, 255, 255, 0.1); color: #e4e4e7; }
  .btn-secondary:active { transform: scale(0.95); }
  .btn-secondary:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
