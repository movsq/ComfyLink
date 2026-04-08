<script>
  let { onClose } = $props();
  let lang = $state('cz');
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
<div class="backdrop" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
  <div class="panel">
    <div class="handle"></div>

    <div class="header">
      <span class="title">{lang === 'en' ? 'HOW WE USE YOUR DATA' : 'JAK NAKLÁDÁME S VAŠIMI DATY'}</span>
      <div class="lang-toggle">
        <button class="lang-btn" class:active={lang === 'en'} onclick={() => { lang = 'en'; }}>EN</button>
        <span class="lang-sep">|</span>
        <button class="lang-btn" class:active={lang === 'cz'} onclick={() => { lang = 'cz'; }}>CZ</button>
      </div>
    </div>

    <div class="scroll-area">
      {#if lang === 'en'}

        <p class="section-heading">What we log for every job</p>
        <p class="body-text">
          Every time you submit an image-generation request, we record the following in our
          database: your <strong>IP address</strong>, the <strong>job timestamp</strong>,
          and a <strong>job identifier</strong>. For Google-authenticated users we also
          store your <strong>Google account identifier</strong> (sub) and
          <strong>email address</strong>. For users authenticating via an access code we
          store only the <strong>code identifier</strong> and your IP address.
        </p>

        <p class="section-heading">What we do NOT store</p>
        <p class="body-text">
          We <strong>never</strong> store your prompts, your uploaded reference images,
          or any generated images in the audit log. Generated images are stored only
          in your personal encrypted vault — they are encrypted by a key that only you
          hold; the server cannot read them.
        </p>

        <p class="section-heading">Why we collect this data</p>
        <p class="body-text">
          The log is required by Czech law and the EU AI Act (Regulation 2024/1689).
          The Czech Telecommunication Office (ČTÚ) may request evidence that the service
          operates in compliance with AI content regulations. IP address records also
          allow us to enforce rate limits and detect abuse.
        </p>

        <p class="section-heading">AI content labelling</p>
        <p class="body-text">
          Every generated image automatically receives an embedded
          <strong>"AI_Generated: yes"</strong> metadata tag in compliance with ČTÚ
          requirements. This tag is written directly into the PNG file at the time
          of generation.
        </p>

        <p class="section-heading">Retention</p>
        <p class="body-text">
          Audit log entries are <strong>automatically deleted after 6 months</strong>.
          We do not retain them longer than legally necessary.
        </p>

        <p class="section-heading">Your rights (GDPR)</p>
        <p class="body-text">
          Under GDPR Arts. 15–22 you have the right to access, rectify, erase, restrict,
          and port your personal data, and to object to processing. To exercise any of
          these rights, contact the operator via the admin account. You also have the
          right to lodge a complaint with the Czech Data Protection Authority
          (Úřad pro ochranu osobních údajů — ÚOOÚ, <strong>www.uoou.cz</strong>).
        </p>

      {:else}

        <p class="section-heading">Co zaznamenáváme ke každé úloze</p>
        <p class="body-text">
          Při každém odeslání požadavku na generování obrázku zaznamenáváme do databáze:
          vaši <strong>IP adresu</strong>, <strong>čas odeslání</strong> a
          <strong>identifikátor úlohy</strong>. U uživatelů přihlášených přes Google
          ukládáme také <strong>identifikátor Google účtu</strong> (sub) a
          <strong>e-mailovou adresu</strong>. U uživatelů přihlášených přístupovým kódem
          ukládáme pouze <strong>identifikátor kódu</strong> a IP adresu.
        </p>

        <p class="section-heading">Co NEUKLÁDÁME</p>
        <p class="body-text">
          Do protokolu <strong>nikdy</strong> neukládáme vaše výzvy (prompty),
          referenční obrázky ani vygenerované obrázky. Vygenerované obrázky jsou uloženy
          pouze ve vašem osobním šifrovaném trezoru — jsou šifrovány klíčem, který máte
          pouze vy; server je nemůže přečíst.
        </p>

        <p class="section-heading">Proč tato data sbíráme</p>
        <p class="body-text">
          Protokol je vyžadován českou legislativou a nařízením EU o umělé inteligenci
          (AI Act, nařízení 2024/1689). Český telekomunikační úřad (ČTÚ) může požadovat
          doklady o souladu se zákonem. Záznamy IP adres také slouží k vymáhání
          rychlostních limitů a odhalování zneužití.
        </p>

        <p class="section-heading">Označování obsahu generovaného AI</p>
        <p class="body-text">
          Každý vygenerovaný obrázek automaticky obdrží vložený metadata tag
          <strong>„AI_Generated: yes"</strong> v souladu s požadavky ČTÚ.
          Tento tag je zapsán přímo do souboru PNG v okamžiku generování.
        </p>

        <p class="section-heading">Uchovávání dat</p>
        <p class="body-text">
          Záznamy v protokolu jsou <strong>automaticky odstraněny po 6 měsících</strong>.
          Neskladujeme je déle, než je zákonem požadováno.
        </p>

        <p class="section-heading">Vaše práva (GDPR)</p>
        <p class="body-text">
          Podle čl. 15–22 GDPR máte právo na přístup k osobním údajům, jejich opravu,
          výmaz, omezení zpracování, přenositelnost a právo vznést námitku. Pro uplatnění
          těchto práv kontaktujte provozovatele prostřednictvím administrátorského účtu.
          Máte také právo podat stížnost u Úřadu pro ochranu osobních údajů (ÚOOÚ,
          <strong>www.uoou.cz</strong>).
        </p>

      {/if}
    </div>

    <div class="actions">
      <button class="btn-primary" onclick={onClose}>
        {lang === 'en' ? 'CLOSE' : 'ZAVŘÍT'}
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
    max-width: 480px;
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
      max-height: 82vh;
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

  .scroll-area {
    overflow-y: auto;
    max-height: 55dvh;
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

  .body-text {
    font-family: 'DM Mono', monospace;
    font-size: 0.68rem; color: #8b96a6;
    line-height: 1.65; margin: 0 0 0.25rem;
  }
  .body-text strong { color: #c2ccd5; }

  .actions {
    display: flex; flex-direction: column; gap: 0.6rem;
    padding-top: 0.25rem;
  }

  .btn-primary {
    width: 100%; padding: 0.8rem;
    background: rgba(82, 116, 144, 0.15);
    border: 1px solid rgba(82, 116, 144, 0.4);
    border-radius: 0.625rem;
    color: #c2ccd5;
    font-family: 'DM Mono', monospace;
    font-size: 0.7rem; letter-spacing: 0.18em;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .btn-primary:hover {
    background: rgba(82, 116, 144, 0.25);
    border-color: rgba(82, 116, 144, 0.65);
  }
</style>
