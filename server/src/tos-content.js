/**
 * tos-content.js — Single source of truth for the Terms of Service text.
 *
 * To update the TOS: edit the HTML strings below (both EN and CZ), then
 * redeploy. The server automatically hashes this file's own source at startup
 * to produce TOS_VERSION — no manual version bump needed.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

// Hash this file's own source so any edit auto-bumps the version.
const _raw = readFileSync(fileURLToPath(import.meta.url), 'utf8');
export const TOS_VERSION = parseInt(createHash('sha256').update(_raw).digest('hex').slice(0, 8), 16);

// ── English ──────────────────────────────────────────────────────────────────
const en = `
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
  Protection Act). The lawful basis for processing is performance of
  contract (Art. 6(1)(b) GDPR) — your account data is required to
  authenticate you and enforce access controls.
</p>
<p class="terms-text">
  Data collected from you: Google account identifier (sub), email address,
  display name, and profile picture. Authentication is handled via Google
  OAuth; Google acts as an independent data controller for the sign-in
  flow and is subject to Google's own Privacy Policy
  (policies.google.com/privacy). Your prompts and generated images are
  end-to-end encrypted; the server has no technical means to access them.
  Vault data (encrypted blobs) is stored on the server but is readable
  only by you. You may delete your vault and all stored results at any
  time via the app.
</p>

<p class="section-heading">7. Your Rights, Retention &amp; Deletion</p>
<p class="terms-text">
  Account data (name, email, profile picture, access timestamps) is
  retained until you request deletion or the Service is discontinued.
  Upon deletion, all vault keys and encrypted results are permanently
  destroyed.
</p>
<p class="terms-text">
  Under GDPR Arts. 15–22 you have the right to: access your personal
  data; have inaccurate data rectified; have your data erased; restrict
  or object to processing; and receive your data in a portable format.
  To exercise any of these rights, contact the Operator via the admin
  account.
</p>
<p class="terms-text">
  You also have the right to lodge a complaint with the Czech Data
  Protection Authority (Úřad pro ochranu osobních údajů — ÚOOÚ,
  <strong>www.uoou.cz</strong>).
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
`.trim();

// ── Czech ────────────────────────────────────────────────────────────────────
const cz = `
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
  údajů). Právním základem zpracování je plnění smlouvy (čl. 6 odst. 1
  písm. b) GDPR) — vaše údaje jsou nezbytné pro ověření totožnosti
  a řízení přístupu.
</p>
<p class="terms-text">
  Shromažďované údaje: identifikátor účtu Google (sub), e-mailová adresa,
  zobrazované jméno a profilový obrázek. Přihlašování probíhá přes Google
  OAuth; Google vystupuje jako samostatný správce údajů pro průběh
  přihlášení a řídí se vlastními zásadami ochrany soukromí
  (policies.google.com/privacy). Vaše prompty a vygenerované obrázky jsou
  end-to-end šifrovány; server k nim nemá technický přístup. Data trezoru
  (šifrované bloby) jsou uložena na serveru, ale přečíst je můžete pouze
  vy. Trezor a všechny uložené výsledky můžete kdykoli smazat přímo
  v aplikaci.
</p>

<p class="section-heading">7. Vaše práva, uchovávání a mazání dat</p>
<p class="terms-text">
  Data účtu (jméno, e-mail, profilový obrázek, záznamy přístupu) jsou
  uchovávána do doby, než požádáte o jejich smazání, nebo do ukončení
  Služby. Po smazání jsou všechny klíče trezoru a šifrované výsledky
  trvale zničeny.
</p>
<p class="terms-text">
  Podle čl. 15–22 GDPR máte právo: na přístup ke svým osobním údajům;
  na opravu nepřesných údajů; na výmaz údajů; na omezení nebo námitku
  proti zpracování; a na přenositelnost údajů. Pro uplatnění těchto práv
  kontaktujte Provozovatele prostřednictvím účtu správce.
</p>
<p class="terms-text">
  Máte rovněž právo podat stížnost u Úřadu pro ochranu osobních údajů
  (ÚOOÚ, <strong>www.uoou.cz</strong>).
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
`.trim();

export const tos = { en, cz };
