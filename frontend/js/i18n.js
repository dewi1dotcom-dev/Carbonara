// Language: English or Norwegian (bokmål), chosen per user.
//
// The code is written in English. A translator walks every text node and the
// placeholder/title/aria-label attributes as they appear in the page, and
// replaces them with the Norwegian text from NO (exact match) or NO_PATTERNS
// (texts with numbers/names in them). confirm()/prompt() go through it too.
// A few texts Carbonara writes in Norwegian on purpose (storage checklist,
// tyre options, battery results) are translated the other way, via EN, when
// English is chosen.
//
// Not translated: anything inside translate="no" (Norwegian documents: PDI
// e-mail preview, privacy notice, storage report), .mono (VINs, plates,
// codes), input values, and data from Statens vegvesen / staff.
//
// Adding UI text: write it in English, then add the Norwegian to NO (or a
// pattern to NO_PATTERNS if it contains a number or name). Check both languages.

const KEY = 'carbonara.lang';

export function detectLang() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'no' || saved === 'en') return saved;
  } catch { /* private mode */ }
  return /^(nb|nn|no)\b/i.test(navigator.language || '') ? 'no' : 'en';
}

export let lang = detectLang();

export function setLang(l) {
  lang = l === 'no' ? 'no' : 'en';
  try { localStorage.setItem(KEY, lang); } catch { /* private mode */ }
  document.documentElement.lang = lang === 'no' ? 'nb' : 'en';
}

/* eslint-disable quote-props */
const NO = {
  // ---- menu, general
  'Deliveries': 'Leveringer', 'Today': 'I dag', 'Arrivals': 'Ankomster', 'Vehicles': 'Biler', 'Storage': 'Lager', 'Test drive': 'Prøvekjøring',
  'Settings': 'Innstillinger', 'System': 'System', 'Account': 'Konto', 'Log in': 'Logg inn', 'Log out': 'Logg ut',
  'Save': 'Lagre', 'Cancel': 'Avbryt', 'Close': 'Lukk', 'Delete': 'Slett', 'Edit': 'Rediger', 'Add': 'Legg til',
  'Remove': 'Fjern', 'Rename': 'Gi nytt navn', 'Restore': 'Gjenopprett', 'Reset': 'Tilbakestill', 'Undo': 'Angre',
  'Use': 'Bruk', 'Move': 'Flytt', 'Retake': 'Ta på nytt', 'Activate': 'Aktiver', 'Deactivate': 'Deaktiver',
  'Optional': 'Valgfritt', 'Other': 'Annet', 'Other: ': 'Annet: ', 'Default': 'Standard', 'Empty': 'Tom', 'Full': 'Full', 'Copied': 'Kopiert',
  'Date': 'Dato', 'Time': 'Klokkeslett', 'From': 'Fra', 'To': 'Til', 'Name': 'Navn', 'Code': 'Kode', 'Zone': 'Sone',
  'Description': 'Beskrivelse', 'Capacity': 'Kapasitet', 'Location': 'Plassering', 'Note': 'Merknad', 'Notes': 'Merknader',
  'Remarks': 'Anmerkninger', 'Field': 'Felt', 'History': 'Historikk', 'Errors': 'Feil', 'Waiting': 'Venter',
  'Synced': 'Synkronisert', 'Inactive': 'Inaktiv', 'Valid': 'Gyldig', 'Calendar': 'Kalender', 'Open calendar': 'Åpne kalender',
  'Loading…': 'Laster…', 'Not found': 'Ikke funnet', 'Back to Today': 'Tilbake til I dag', 'Try again': 'Prøv igjen',
  'Could not load this page. ': 'Kunne ikke laste siden. ', 'Cannot reach the server. ': 'Får ikke kontakt med serveren. ',
  'Cannot reach the server. Check the network connection.': 'Får ikke kontakt med serveren. Sjekk nettverkstilkoblingen.',
  'Admin': 'Admin', 'Administrator': 'Administrator', 'System admin': 'Systemadministrator', 'Staff': 'Ansatt',
  'Customer': 'Kunde', 'Car': 'Bil', 'Cars': 'Biler', 'Action': 'Tiltak', 'Extra': 'Ekstra', 'Type': 'Type',
  'Unknown vehicle': 'Ukjent bil', 'unknown': 'ukjent', 'Vehicle': 'Kjøretøy', 'Deleted vehicle': 'Slettet bil',
  '(inactive)': '(inaktiv)', '(removed)': '(fjernet)', '(you)': '(deg)', 'Not set': 'Ikke satt', 'No limit': 'Ingen grense',
  'no limit': 'ingen grense', 'Not OK': 'Ikke OK', 'OK': 'OK', 'N/A': 'I/A', 'Today:': 'I dag:',
  // ---- status / pills
  'In storage': 'På lager', 'Off site': 'Ikke på lager', 'Arrival inspection': 'Mottakskontroll', 'In progress': 'Pågår',
  'Completed': 'Fullført', 'Cancelled': 'Avbrutt', 'Registered': 'Registrert', 'Not registered': 'Ikke registrert',
  'Registered · awaiting data': 'Registrert · venter på data', 'Valid ': 'Gyldig ', 'Due today': 'Frist i dag',
  'Due tomorrow': 'Frist i morgen', 'Service OK': 'Service OK', 'Service due today': 'Service forfaller i dag',
  'New from factory': 'Ny fra fabrikk', 'Used': 'Brukt', 'New/used': 'Ny/brukt', 'Condition': 'Tilstand',
  // ---- fuel / vehicle fields
  'Petrol': 'Bensin', 'Diesel': 'Diesel', 'Hybrid': 'Hybrid', 'Plug-in hybrid': 'Ladbar hybrid', 'Electric': 'Elektrisk',
  'LPG': 'LPG', 'CNG': 'CNG', 'Hydrogen': 'Hydrogen', 'Make': 'Merke', 'Model': 'Modell', 'Make *': 'Merke *',
  'Model *': 'Modell *', 'Make / model': 'Merke / modell', 'Model year': 'Årsmodell', 'Variant': 'Variant',
  'Variant / trim': 'Variant / utstyrsnivå', 'Colour': 'Farge', 'Fuel': 'Drivstoff', 'Fuel type': 'Drivstoff',
  'Fuel / charge level': 'Drivstoff / ladenivå', 'Registration no.': 'Registreringsnr.', 'Reg. no': 'Reg.nr.',
  'No reg. no': 'Uten reg.nr.', 'Registration number (if the car has one)': 'Registreringsnummer (hvis bilen har det)',
  'VIN (chassis number)': 'VIN (understellsnummer)', '17-character VIN': 'VIN på 17 tegn', 'VIN location': 'VIN-plassering',
  'VIN plate': 'VIN-skilt', 'Odometer (km) *': 'Kilometerstand (km) *', 'Odometer reading': 'Kilometerstand',
  'Keys received': 'Antall nøkler mottatt', 'Registration': 'Registrering', 'Registration status': 'Registreringsstatus',
  'EU-kontroll': 'EU-kontroll', 'EU-kontroll: ': 'EU-kontroll: ', 'EU-kontroll due': 'EU-kontroll frist', 'EU-kontroll approved': 'EU-kontroll godkjent',
  'Last approved': 'Sist godkjent', 'Storage spot': 'Lagerplass', 'Last service': 'Siste service',
  'Last service date': 'Dato for siste service', 'Km at last service': 'Km ved siste service', 'finn.no code': 'finn.no-kode',
  'In system since': 'I systemet siden', 'Marked by': 'Markert av', 'Registered in Norway': 'Registrert i Norge',
  'New or used': 'Ny eller brukt', 'New or used? *': 'Ny eller brukt? *', 'Choose…': 'Velg…', 'Service': 'Service',
  'Service date': 'Servicedato', 'Odometer at service (km)': 'Kilometerstand ved service (km)',
  'Odometer at last service (km)': 'Kilometerstand ved siste service (km)', 'Save service': 'Lagre service',
  'Service done': 'Service utført', 'Service recorded': 'Service registrert', 'Service due': 'Service forfaller',
  'Leave empty if the service history is unknown; the next service is then estimated from the registration date.':
    'La stå tomt hvis servicehistorikken er ukjent; neste service beregnes da fra registreringsdatoen.',
  'New car: no service record needed. The first service is due one year after registration (date from Statens vegvesen).':
    'Ny bil: ingen servicehistorikk trengs. Første service er ett år etter registrering (dato fra Statens vegvesen).',
  'Choose new or used (Edit details) to track service': 'Velg ny eller brukt (Rediger detaljer) for å følge opp service',
  'First service: one year after registration.': 'Første service: ett år etter registrering.',
  'No service history recorded; based on the registration date.': 'Ingen servicehistorikk registrert; basert på registreringsdatoen.',
  'First service is due one year after registration.': 'Første service er ett år etter registrering.',
  'No service history or registration date yet.': 'Ingen servicehistorikk eller registreringsdato ennå.',
  // ---- vehicles list & page
  'Search VIN, make, model, reg. no or spot…': 'Søk VIN, merke, modell, reg.nr. eller plass…', 'All statuses': 'Alle statuser',
  'New and used': 'Nye og brukte', 'Factory new cars': 'Fabrikknye biler', 'Used cars': 'Bruktbiler', 'New/used not chosen': 'Ny/brukt ikke valgt',
  'New or used': 'Ny eller brukt',
  '🗑 Recently deleted': '🗑 Nylig slettet', 'Recently deleted': 'Nylig slettet', 'No vehicles found.': 'Ingen biler funnet.',
  '← Vehicles': '← Biler', 'Edit details': 'Rediger detaljer', 'Edit vehicle details': 'Rediger bildetaljer', 'Details saved': 'Detaljer lagret',
  'Return to storage': 'Tilbake til lager', 'Move car': 'Flytt bil', 'Move to': 'Flytt til', 'Moved by': 'Flyttet av',
  'Choose a storage spot first': 'Velg en lagerplass først', 'Off site (workshop, test drive, delivered…)': 'Ikke på lager (verksted, prøvekjøring, levert…)',
  'Optional, e.g. "At workshop for paint"': 'Valgfritt, f.eks. «Hos verksted for lakk»', 'Currently off site.': 'Er nå ikke på lager.',
  'Known damage': 'Kjente skader', 'No unrepaired damage on record.': 'Ingen ureparerte skader registrert.', '✓ Repaired': '✓ Reparert',
  'Mark repaired': 'Merk som reparert', 'Repair note': 'Reparasjonsmerknad', 'Optional, e.g. "Repainted by workshop"': 'Valgfritt, f.eks. «Lakkert av verksted»',
  'Damage marked as repaired': 'Skaden er merket som reparert', 'Repair undone': 'Reparasjon angret',
  'Undo "repaired"? The damage will be listed as known damage again.': 'Angre «reparert»? Skaden vises som kjent skade igjen.',
  'Inspections': 'Kontroller', 'Vehicle history →': 'Bilens historikk →', '🗑 Delete car': '🗑 Slett bil', 'View vehicle': 'Vis bil',
  'Mark as registered': 'Merk som registrert', 'Undo mark': 'Angre merking', '↻ Sync now': '↻ Synkroniser nå', 'Raw data': 'Rådata',
  'Synced with Statens vegvesen': 'Synkronisert med Statens vegvesen',
  'Synced · Statens vegvesen lists the car as registered, so it is now marked as registered':
    'Synkronisert · Statens vegvesen oppgir bilen som registrert, så den er nå merket som registrert',
  'Fetch the latest data from Statens vegvesen now': 'Hent de nyeste dataene fra Statens vegvesen nå',
  'The Statens vegvesen API key is not configured': 'API-nøkkelen til Statens vegvesen er ikke satt',
  'All vehicle data': 'Alle kjøretøydata', 'Statens vegvesen': 'Statens vegvesen', 'Statens vegvesen data': 'Data fra Statens vegvesen',
  'Not registered yet. When sales has registered the car, use "Mark as registered" above to fetch its data.':
    'Ikke registrert ennå. Når salg har registrert bilen, bruk «Merk som registrert» over for å hente data.',
  'Remove the "registered" mark? Registry data already fetched is kept, but syncing stops.':
    'Fjerne merkingen «registrert»? Data som allerede er hentet beholdes, men synkroniseringen stopper.',
  'Technical data, registration number and EU-kontroll dates will then be fetched from Statens vegvesen and kept up to date automatically.':
    'Tekniske data, registreringsnummer og EU-kontrolldatoer hentes da fra Statens vegvesen og holdes oppdatert automatisk.',
  'Marked as registered': 'Merket som registrert', 'Marked as registered — data fetched from Statens vegvesen': 'Merket som registrert — data hentet fra Statens vegvesen',
  'Marked as registered. Registry sync starts once the API key is configured.': 'Merket som registrert. Synkronisering starter når API-nøkkelen er satt.',
  'Synced with Statens vegvesen': 'Synkronisert med Statens vegvesen', 'Sync failed — will retry automatically': 'Synkronisering feilet — prøver igjen automatisk',
  'Not found in the vehicle registry yet — retried daily': 'Ikke funnet i kjøretøyregisteret ennå — prøves daglig',
  'Waiting for first sync with Statens vegvesen': 'Venter på første synkronisering med Statens vegvesen',
  'No date from Statens vegvesen yet': 'Ingen dato fra Statens vegvesen ennå', 'No data yet.': 'Ingen data ennå.',
  'Statens vegvesen does not list this car as registered.': 'Statens vegvesen oppgir ikke bilen som registrert.',
  'The Statens vegvesen API key is not configured on the server, so no data can be fetched yet.': 'API-nøkkelen til Statens vegvesen er ikke satt, så ingen data kan hentes ennå.',
  'Check data: Statens vegvesen differs': 'Sjekk data: Statens vegvesen avviker', 'Use Statens vegvesen': 'Bruk Statens vegvesen', 'Keep ours': 'Behold vår',
  'On file': 'Registrert hos oss', 'In Carbonara': 'I Carbonara', 'Differs from what we have on file': 'Avviker fra det vi har registrert',
  '"Keep ours" is remembered until Statens vegvesen changes the value again.': '«Behold vår» huskes til Statens vegvesen endrer verdien igjen.',
  'Tick at least one field': 'Kryss av minst ett felt', '✓ Matches Statens vegvesen': '✓ Stemmer med Statens vegvesen',
  'Tick the fields this applies to and choose which value is right. ': 'Kryss av feltene dette gjelder og velg hvilken verdi som er riktig. ',
  'Not on finn.no': 'Ikke på finn.no', '+ Add finn.no link': '+ Legg til finn.no-lenke', 'Available on finn.no ↗': 'Tilgjengelig på finn.no ↗',
  'finn.no ad': 'finn.no-annonse', 'finn.no link or FINN code': 'finn.no-lenke eller FINN-kode', 'Paste the ad link': 'Lim inn annonselenken',
  'Remove link': 'Fjern lenke', 'change': 'endre', 'finn.no link saved': 'finn.no-lenke lagret', 'finn.no link removed': 'finn.no-lenke fjernet',
  'Open the car’s ad on finn.no, copy the address from the browser and paste it here (the FINN code alone works too).':
    'Åpne bilens annonse på finn.no, kopier adressen fra nettleseren og lim den inn her (FINN-koden alene fungerer også).',
  'Possible duplicate': 'Mulig duplikat', 'Possible duplicates': 'Mulige duplikater',
  'Almost the same VIN is already in Carbonara: ': 'Nesten samme VIN finnes allerede i Carbonara: ', ' Use this VIN': ' Bruk denne VIN-en',
  '(VIN ': '(VIN ', '). Same car with a mistyped VIN?': '). Samme bil med feilskrevet VIN?', ' on ': ' på ',
  'Nothing here. Deleted cars appear here and can be restored for a while.': 'Ingenting her. Slettede biler vises her og kan gjenopprettes en stund.',
  'Delete permanently': 'Slett permanent', 'Deleted permanently': 'Slettet permanent', 'Restored from Recently deleted': 'Gjenopprettet fra Nylig slettet',
  'Restored (off site — use Move to place it)': 'Gjenopprettet (ikke på lager — bruk Flytt for å plassere den)',
  'After that period it is removed for good, with its inspections, photos and history.': 'Etter den perioden slettes den for godt, med kontroller, bilder og historikk.',
  // history
  'Added to the system': 'Lagt inn i systemet', 'Arrival inspection started': 'Mottakskontroll startet', 'Arrival inspection completed': 'Mottakskontroll fullført',
  'Arrival inspection cancelled': 'Mottakskontroll avbrutt', 'Placed in storage': 'Plassert på lager', 'Details updated': 'Detaljer oppdatert',
  'Marked as registered in Norway': 'Merket som registrert i Norge', '"Registered" mark removed': 'Merkingen «registrert» fjernet',
  'Data fetched from Statens vegvesen': 'Data hentet fra Statens vegvesen', 'Updated from Statens vegvesen': 'Oppdatert fra Statens vegvesen',
  'Moved': 'Flyttet', 'Taken off site': 'Tatt ut av lager', 'Damage repaired': 'Skade reparert', '"Repaired" undone': '«Reparert» angret',
  'Checked against Statens vegvesen': 'Kontrollert mot Statens vegvesen', 'Deleted': 'Slettet', 'Out on test drive': 'Ute på prøvekjøring',
  'Back from test drive': 'Tilbake fra prøvekjøring', 'PDI order sent': 'Bestilling av nybilklargjøring sendt', 'PDI booked': 'Nybilklargjøring booket',
  'PDI date removed': 'Dato for nybilklargjøring fjernet', 'PDI done': 'Nybilklargjøring utført', 'PDI order cancelled': 'Bestilling av nybilklargjøring avbrutt',
  'Storage check': 'Lagerkontroll', 'Storage check cancelled': 'Lagerkontroll annullert',
  'Automatically — listed as registered in Statens vegvesen': 'Automatisk — oppført som registrert hos Statens vegvesen',
  'from e-mail app': 'fra e-postprogram', 'sent again': 'sendt på nytt', 'Items not all back': 'Ikke alt utstyr tilbake',
  'First storage check': 'Første lagerkontroll', 'Monthly': 'Månedlig', 'Monthly check': 'Månedlig sjekk', '3-month check': '3-månederssjekk',
  '6-month check': '6-månederssjekk',
  // ---- today
  '+ New arrival': '+ Ny ankomst', 'Needs attention': 'Trenger oppfølging', 'PDI tomorrow – make the car ready': 'Nybilklargjøring i morgen – klargjør bilen',
  'PDI today': 'Nybilklargjøring i dag', 'PDI date passed – mark as done?': 'Dato for nybilklargjøring passert – merk som utført?',
  'Arrivals in progress': 'Pågående ankomster', 'PDI orders waiting for the workshop’s reply': 'Bestillinger som venter på svar fra verkstedet',
  'PDI orders not sent yet': 'Bestillinger som ikke er sendt ennå', 'Statens vegvesen differences to check': 'Avvik mot Statens vegvesen som må sjekkes',
  'open the car to confirm': 'åpne bilen for å bekrefte', 'Nothing needs attention. 👍': 'Ingenting trenger oppfølging. 👍',
  'Upcoming PDIs': 'Kommende nybilklargjøringer', 'In storage ': 'På lager ', 'Free places': 'Ledige plasser', 'Arrived this week': 'Ankommet denne uken',
  'PDIs this week': 'Nybilklargjøringer denne uken', 'Storage checks due (new cars)': 'Lagerkontroller som forfaller (nye biler)',
  'first storage check missing': 'første lagerkontroll mangler', 'today': 'i dag', 'tomorrow': 'i morgen',
  // ---- PDI page + vehicle banner/badge
  'PDI': 'Nybilklargjøring', 'New cars booked for PDI at the workshop': 'Nye biler som er booket til nybilklargjøring på verkstedet',
  'This week': 'Denne uken', 'Later': 'Senere', 'Waiting for the workshop’s date': 'Venter på dato fra verkstedet', 'Not sent yet': 'Ikke sendt ennå',
  'Recently done': 'Nylig utført', 'No PDIs this week.': 'Ingen nybilklargjøringer denne uken.', 'done': 'utført', 'order not sent': 'bestilling ikke sendt',
  'PDI ordered – waiting for the workshop’s date': 'Nybilklargjøring bestilt – venter på dato fra verkstedet',
  'PDI order started – not sent to the workshop yet': 'Bestilling av nybilklargjøring påbegynt – ikke sendt til verkstedet ennå',
  'The order list has not been sent to the workshop yet.': 'Bestillingen er ikke sendt til verkstedet ennå.', 'See order': 'Se bestillingen',
  'All PDIs': 'Alle nybilklargjøringer', 'PDI ordered': 'Nybilklargjøring bestilt', 'PDI not sent': 'Bestilling ikke sendt',
  'Ready for registration and delivery': 'Klar for registrering og levering',
  'Print or PDF': 'Skriv ut eller PDF', 'Printed / PDF': 'Skrevet ut / PDF', 'Already given – mark as sent': 'Allerede levert – merk som sendt',
  'Print the order for the workshop, or choose “Save as PDF” in the print window to send or store it as a file.':
    'Skriv ut bestillingen til verkstedet, eller velg «Lagre som PDF» i utskriftsvinduet for å sende eller lagre den som fil.',
  'Did you give the order to the workshop (printed or as a PDF)?': 'Har du gitt bestillingen til verkstedet (utskrift eller PDF)?',
  'Marked as given to the workshop': 'Merket som levert til verkstedet', 'Choose who to send it to': 'Velg hvem den skal sendes til',
  // staff
  'First name': 'Fornavn', 'Last name': 'Etternavn', 'First and last name': 'Fornavn og etternavn', 'Saved': 'Lagret',
  'last name': 'etternavn', 'phone': 'telefon', 'last name, phone': 'etternavn, telefon',
  'First and last name are required': 'Fornavn og etternavn må fylles ut',
  'Deactivate the staff member before deleting them': 'Deaktiver den ansatte før du sletter vedkommende',
  "You can't delete yourself": 'Du kan ikke slette deg selv',
  // PDI: given? / preparation / notification
  'Yes': 'Ja', 'No': 'Nei', 'Order given to the workshop?': 'Bestilling levert til verkstedet?', 'PDI date (optional)': 'Dato for nybilklargjøring (valgfritt)',
  'Fill in if the workshop has already given a date and time.': 'Fyll ut hvis verkstedet allerede har gitt dato og klokkeslett.',
  'Did you send the e-mail from your e-mail app?': 'Sendte du e-posten fra e-postprogrammet ditt?',
  'Prepare for PDI': 'Klargjør til nybilklargjøring', 'Edit preparation': 'Endre klargjøring', 'Prepare': 'Klargjør', 'prepare the car': 'klargjør bilen',
  'Prepared for PDI': 'Klargjort til nybilklargjøring', '✓ Mark as prepared': '✓ Merk som klargjort', 'prepared': 'klargjort', 'not prepared yet': 'ikke klargjort ennå',
  'Where is the car?': 'Hvor står bilen?', 'Message (optional)': 'Melding (valgfritt)', 'e.g. Keys in the key cabinet': 'f.eks. Nøkler i nøkkelskapet',
  'Choosing another spot moves the car there.': 'Velger du en annen plass, flyttes bilen dit.', 'Where are the winter wheels?': 'Hvor står vinterhjulene?',
  'e.g. Tyre storage, shelf 3 (or: not delivered yet)': 'f.eks. Dekkhotell, hylle 3 (eller: ikke levert ennå)',
  'Winter wheels in stock at the dealer.': 'Vinterhjul på lager hos forhandleren.', 'Winter wheels ordered by sales.': 'Vinterhjul bestilt av selger.',
  'Write where the winter wheels are (or that they have not arrived)': 'Skriv hvor vinterhjulene står (eller at de ikke har kommet)',
  'Car marked as prepared for the PDI': 'Bilen er merket som klargjort til nybilklargjøring',
  'PDI done – the car is ready for registration and delivery': 'Nybilklargjøring utført – bilen er klar for registrering og levering',
  // ---- arrivals / intake / inspection
  'New arrival': 'Ny ankomst', 'No arrival inspections in progress.': 'Ingen pågående mottakskontroller.', 'Recently placed in storage': 'Nylig plassert på lager',
  'Nothing yet.': 'Ingenting ennå.', 'Select inspector…': 'Velg kontrollør…', 'Select staff…': 'Velg ansatt…', 'Inspector': 'Kontrollør',
  'Checked by': 'Kontrollert av', 'Add at least one staff member before starting inspections. ': 'Legg til minst én ansatt før du starter kontroller. ',
  'Go to settings': 'Gå til innstillinger', 'Find VIN': 'Finn VIN', 'Looking up…': 'Slår opp…', 'Type a registration number first.': 'Skriv inn et registreringsnummer først.',
  'No car found with this registration number.': 'Ingen bil funnet med dette registreringsnummeret.', '✓ Found — VIN filled in from Statens vegvesen': '✓ Funnet — VIN fylt inn fra Statens vegvesen',
  'Checking Statens vegvesen…': 'Sjekker Statens vegvesen…', 'Not found in Statens vegvesen — normal for cars not yet registered in Norway.': 'Ikke funnet hos Statens vegvesen — normalt for biler som ikke er registrert i Norge ennå.',
  'Statens vegvesen API key is not configured on the server.': 'API-nøkkelen til Statens vegvesen er ikke satt på serveren.',
  'The data is saved when the inspection starts.': 'Dataene lagres når kontrollen starter.', 'The data is saved and the car is marked as registered when the inspection starts.': 'Dataene lagres og bilen merkes som registrert når kontrollen starter.',
  'Ticked fields are updated to the Statens vegvesen value when the inspection starts.': 'Avkryssede felt oppdateres til verdien fra Statens vegvesen når kontrollen starter.',
  '📷 Read VIN or plate from photo': '📷 Les VIN eller skilt fra bilde', 'Reading photo…': 'Leser bilde…', 'Text recognition': 'Tekstgjenkjenning', 'Barcode': 'Strekkode',
  'No VIN or registration plate found. Try again a bit closer, avoid glare, or type it in.': 'Fant ingen VIN eller skilt. Prøv litt nærmere, unngå gjenskinn, eller skriv det inn.',
  'Possible VINs — tap the right one:': 'Mulige VIN — trykk på riktig:', 'Possible plates — tap the right one:': 'Mulige skilt — trykk på riktig:',
  'VIN found:': 'VIN funnet:', 'Registration plate found:': 'Registreringsskilt funnet:',
  'Tip: photograph the registration plate, the VIN plate at the bottom of the windscreen, the label in the driver door frame (barcode), or the registration document. The photo does not need to be level.':
    'Tips: ta bilde av skiltet, VIN-skiltet nederst i frontruten, merket i førerdørkarmen (strekkode) eller vognkortet. Bildet trenger ikke være rett.',
  '✓ Valid VIN (check digit matches)': '✓ Gyldig VIN (kontrollsiffer stemmer)',
  '✓ Valid format. (Check digit not used by this manufacturer — normal for many European cars.)': '✓ Gyldig format. (Kontrollsiffer brukes ikke av denne produsenten — normalt for mange europeiske biler.)',
  'Check digit does not match — for this manufacturer a character is probably wrong.': 'Kontrollsifferet stemmer ikke — for denne produsenten er trolig et tegn feil.',
  'Check digit does not match. ': 'Kontrollsifferet stemmer ikke. ',
  'For this manufacturer that means a character is probably wrong (8/B, 5/S, 0/D, 2/Z…). Compare with the car.': 'For denne produsenten betyr det trolig at et tegn er feil (8/B, 5/S, 0/D, 2/Z…). Sammenlign med bilen.',
  'Only letters and digits are allowed.': 'Bare bokstaver og tall er tillatt.', 'New vehicle — not seen before.': 'Ny bil — ikke sett før.',
  'Start inspection': 'Start kontroll', 'Continue inspection': 'Fortsett kontroll', 'Always compare with the car before starting.': 'Sammenlign alltid med bilen før du starter.',
  'Personalised plate? · tap to look up': 'Personlig skilt? · trykk for å slå opp',
  '1. Vehicle details': '1. Bildetaljer', '2. Photos': '2. Bilder', '3. Damage inspection': '3. Skadekontroll', '4. Place in storage': '4. Plasser på lager', '4. Storage': '4. Lager',
  '5. Place in storage': '5. Plasser på lager', '5. Storage': '5. Lager', '4. First storage check': '4. Første lagerkontroll',
  'First storage check done (new car)': 'Første lagerkontroll utført (ny bil)', 'first storage check done (new car)': 'første lagerkontroll utført (ny bil)',
  'Do first storage check': 'Utfør første lagerkontroll',
  'Factory-new car: MG’s storage requirements start with this check (parking, 12V battery, tyre pressure). It is saved on the car, and the monthly storage checks follow from it.':
    'Fabrikkny bil: MGs lagringskrav starter med denne kontrollen (parkering, 12V-batteri, dekktrykk). Den lagres på bilen, og de månedlige lagerkontrollene følger av den.',
  '✓ Saved': '✓ Lagret', 'Still to do: ': 'Gjenstår: ', 'Make and model recorded': 'Merke og modell registrert', 'New or used car selected': 'Ny eller brukt bil valgt',
  'Odometer reading recorded': 'Kilometerstand registrert', 'Photos from all four sides': 'Bilder fra alle fire sider', 'Damage inspection done': 'Skadekontroll utført',
  'Take one photo from each side with the whole car in frame. "Left" means the left side when sitting in the car.': 'Ta ett bilde fra hver side med hele bilen i bildet. «Venstre» betyr venstre side sett fra førersetet.',
  '📷 Take photo': '📷 Ta bilde', '📷 Retake photo': '📷 Ta nytt bilde', '+ Extra photo': '+ Ekstra bilde', 'Extra photo': 'Ekstra bilde', 'no photo': 'ingen bilde',
  'Delete this photo?': 'Slette dette bildet?', 'Photo': 'Bilde', 'Damage photo': 'Skadebilde', 'Photo of the damage': 'Bilde av skaden', 'Open original': 'Åpne original',
  'Walk around the car. Tap the diagram where you find damage.': 'Gå rundt bilen. Trykk på diagrammet der du finner skade.',
  '+ Add damage without diagram position': '+ Legg til skade uten plassering i diagrammet', 'Add damage': 'Legg til skade', 'Damage': 'Skade',
  'No damage recorded.': 'Ingen skader registrert.', ' No damage found on this vehicle': ' Ingen skader funnet på denne bilen', 'Delete this damage?': 'Slette denne skaden?',
  'Severity': 'Alvorlighet', 'Size (mm)': 'Størrelse (mm)', 'Car damage diagram, front at the top': 'Skadediagram for bil, front øverst', '▲ FRONT': '▲ FRONT',
  'scratch': 'ripe', 'dent': 'bulk', 'chip': 'steinsprut', 'crack': 'sprekk', 'scuff': 'skrubbmerke', 'rust': 'rust', 'broken': 'ødelagt', 'missing': 'mangler', 'other': 'annet',
  'Scratch': 'Ripe', 'Dent': 'Bulk', 'Chip': 'Steinsprut', 'Crack': 'Sprekk', 'Scuff': 'Skrubbmerke', 'Rust': 'Rust', 'Broken': 'Ødelagt', 'Missing': 'Mangler',
  'minor': 'liten', 'moderate': 'middels', 'severe': 'alvorlig', 'Minor': 'Liten', 'Moderate': 'Middels', 'Severe': 'Alvorlig',
  'Front': 'Front', 'Rear': 'Bak', 'Left': 'Venstre', 'Right': 'Høyre', 'Left side': 'Venstre side', 'Right side': 'Høyre side', 'Roof': 'Tak', 'Interior': 'Interiør',
  'Underbody': 'Understell', 'Windscreen': 'Frontrute', 'Rear window': 'Bakrute', 'Bonnet / hood': 'Panser', 'Boot / tailgate': 'Bagasjelokk / bakluke',
  'Front bumper': 'Støtfanger foran', 'Rear bumper': 'Støtfanger bak', 'Grille': 'Grill', 'Left front door': 'Venstre fordør', 'Left rear door': 'Venstre bakdør',
  'Right front door': 'Høyre fordør', 'Right rear door': 'Høyre bakdør', 'Left front wing': 'Venstre forskjerm', 'Right front wing': 'Høyre forskjerm',
  'Left rear quarter': 'Venstre bakskjerm', 'Right rear quarter': 'Høyre bakskjerm', 'Left sill': 'Venstre dørterskel', 'Right sill': 'Høyre dørterskel',
  'Left headlight': 'Venstre frontlykt', 'Right headlight': 'Høyre frontlykt', 'Left tail light': 'Venstre baklykt', 'Right tail light': 'Høyre baklykt',
  'Left mirror': 'Venstre speil', 'Right mirror': 'Høyre speil', 'Left front wheel / tyre': 'Venstre forhjul / dekk', 'Right front wheel / tyre': 'Høyre forhjul / dekk',
  'Left rear wheel / tyre': 'Venstre bakhjul / dekk', 'Right rear wheel / tyre': 'Høyre bakhjul / dekk',
  'Placed when the arrival inspection is completed': 'Plasseres når mottakskontrollen er fullført', 'Complete & place in storage': 'Fullfør og plasser på lager',
  'Cancel inspection': 'Avbryt kontroll', 'Cancel this arrival inspection? It stays in the vehicle history as cancelled.': 'Avbryte denne mottakskontrollen? Den blir stående i bilens historikk som avbrutt.',
  'Cancelled': 'Avbrutt', 'All storage spots are full. ': 'Alle lagerplasser er fulle. ', 'Add spots or raise capacity in settings': 'Legg til plasser eller øk kapasiteten i innstillingene',
  'Add spots in settings': 'Legg til plasser i innstillingene', 'Notes': 'Merknader',
  // ---- storage page
  '← All storage': '← Alt lager', 'No storage spots yet.': 'Ingen lagerplasser ennå.', 'No storage spots yet. ': 'Ingen lagerplasser ennå. ', 'Manage spots →': 'Administrer plasser →',
  'No zone': 'Ingen sone', 'No cars here.': 'Ingen biler her.', 'No cars in this spot.': 'Ingen biler på denne plassen.', 'No cars are off site.': 'Ingen biler er utenfor lageret.',
  'Not in a sub-zone': 'Ikke i en undersone', 'These cars were placed before the spot was split. Open a car and use Move to put it in a sub-zone.': 'Disse bilene ble plassert før plassen ble delt. Åpne en bil og bruk Flytt for å sette den i en undersone.',
  'Workshop, test drive, delivered…': 'Verksted, prøvekjøring, levert…', 'empty →': 'tom →', 'Away': 'Utenfor lageret',
  'Select…': 'Velg…', 'Currently off site.': 'Er nå ikke på lager.',
  // ---- test drive
  'Start a test drive': 'Start en prøvekjøring', 'Search reg. no, VIN, make, model, colour or spot…': 'Søk reg.nr., VIN, merke, modell, farge eller plass…',
  'No cars found.': 'Ingen biler funnet.', 'Choose another car': 'Velg en annen bil', 'Customer': 'Kunde', 'Driving licence': 'Førerkort', 'Phone number': 'Telefonnummer',
  '📷 Photo of driving licence': '📷 Bilde av førerkort', '📷 Retake licence photo': '📷 Ta nytt bilde av førerkort', 'No photo yet': 'Ingen bilde ennå',
  'Take the photo first — the name is filled in from the licence.': 'Ta bildet først — navnet fylles inn fra førerkortet.',
  'Reading the name from the licence…': 'Leser navnet fra førerkortet…', '✓ Read from the licence — check the spelling.': '✓ Lest fra førerkortet — sjekk stavemåten.',
  '⚠ Read from the licence, but unsure — check it carefully.': '⚠ Lest fra førerkortet, men usikkert — sjekk nøye.', 'Could not read the name from the photo. Type it in.': 'Klarte ikke å lese navnet fra bildet. Skriv det inn.',
  'The car': 'Bilen', 'Taken out of the car for the test drive': 'Tatt ut av bilen for prøvekjøringen', 'Put into the car for the test drive': 'Lagt i bilen for prøvekjøringen',
  'Other (separate with commas)': 'Annet (skill med komma)', 'Odometer out (optional)': 'Kilometerstand ut (valgfritt)', 'Handed out by': 'Utlevert av', 'Note (optional)': 'Merknad (valgfritt)',
  'The customer has been given the privacy information ': 'Kunden har fått personverninformasjonen ', '(show / print)': '(vis / skriv ut)',
  'Start test drive': 'Start prøvekjøring', '🔑 Start test drive': '🔑 Start prøvekjøring', 'Take a photo of the driving licence first': 'Ta bilde av førerkortet først',
  'Give the customer the privacy information and tick the box': 'Gi kunden personverninformasjonen og kryss av', 'No cars are out on a test drive.': 'Ingen biler er ute på prøvekjøring.',
  'Returned': 'Levert tilbake', 'Check that the car is back as it was': 'Sjekk at bilen er tilbake slik den var', 'Odometer in (optional)': 'Kilometerstand inn (valgfritt)',
  'Received by': 'Mottatt av', 'Note (required if something is missing)': 'Merknad (påkrevd hvis noe mangler)', 'Register return': 'Registrer innlevering', 'Car returned': 'Bil levert tilbake',
  'e.g. winter wheels left at the customer': 'f.eks. vinterhjul igjen hos kunden', 'Tick every item, or write a note about what is missing': 'Kryss av alle punkter, eller skriv hva som mangler',
  'Test drive returned · customer details moved to the trash': 'Prøvekjøring levert · kundeopplysninger flyttet til papirkurven',
  'The customer’s name, phone number and licence photo are moved to the trash and deleted for good after 30 days.': 'Kundens navn, telefonnummer og førerkortbilde flyttes til papirkurven og slettes for godt etter 30 dager.',
  'Licence': 'Førerkort', 'Access log': 'Tilgangslogg', 'Delete now': 'Slett nå', 'Customer details deleted': 'Kundeopplysninger slettet', 'Nothing in the trash.': 'Papirkurven er tom.',
  'Nobody has opened the licence photo.': 'Ingen har åpnet førerkortbildet.', 'Opened licence photo': 'Åpnet førerkortbilde', 'Deleted customer details': 'Slettet kundeopplysninger',
  'On test drive': 'På prøvekjøring', 'Go to Test drive': 'Gå til Prøvekjøring', '🔒 Privacy notice for customers': '🔒 Personvernerklæring for kunder', '🖨 Print': '🖨 Skriv ut',
  'The customer privacy notice has no contact details yet. A system admin can add them on the System page → Company.': 'Personvernerklæringen mangler kontaktinformasjon. En systemadministrator kan legge den inn under System → Firma.',
  'Winter wheels': 'Vinterhjul', 'Summer wheels': 'Sommerhjul', 'Charging cable': 'Ladekabel', 'Floor mats': 'Gulvmatter', 'Cargo cover / parcel shelf': 'Bagasjeromstrekk / hattehylle',
  // trade plates
  'Trade plates': 'Prøvekjennemerker', 'No trade plates': 'Ingen prøvekjennemerker', 'No trade plates yet.': 'Ingen prøvekjennemerker ennå.',
  'No trade plates yet. An administrator can add them under Settings → Trade plates.': 'Ingen prøvekjennemerker ennå. En administrator kan legge dem til under Innstillinger → Prøvekjennemerker.',
  'Name, e.g. Plates 1 (P 12345)': 'Navn, f.eks. Prøveskilt 1 (P 12345)', '– free': '– ledig',
  'The trade plates chosen when a test drive starts. A set can only be on one car at a time. Rename a set when a plate is replaced.':
    'Prøvekjennemerkene som velges når en prøvekjøring starter. Et sett kan bare stå på én bil om gangen. Gi settet nytt navn når et skilt byttes.',
  'The trade plates chosen when a test drive starts. Only an administrator can change this list.':
    'Prøvekjennemerkene som velges når en prøvekjøring starter. Bare en administrator kan endre denne listen.',
  'Trade plates moved to another car': 'Prøvekjennemerker flyttet til en annen bil',
  'trade plates moved to another car – register the return': 'prøvekjennemerker flyttet til en annen bil – registrer innlevering',
  'Give the trade plates a name': 'Gi prøvekjennemerkene et navn',
  'These trade plates are on a car out on a test drive; register the return first': 'Disse prøvekjennemerkene står på en bil som er ute på prøvekjøring; registrer innlevering først',
  'This car or these trade plates were just taken by someone else; reload and try again': 'Denne bilen eller disse prøvekjennemerkene ble akkurat tatt av noen andre; last inn på nytt og prøv igjen',
  'Trade plates (prøvekjennemerker)': 'Prøvekjennemerker', 'Fuel / charging card': 'Drivstoff- / ladekort', 'Child seat': 'Barnesete', 'e.g. 912 34 567': 'f.eks. 912 34 567',
  // ---- PDI (nybilklargjøring)
  'PDI order': 'Bestilling av nybilklargjøring', 'No PDI order.': 'Ingen bestilling av nybilklargjøring.', 'Create PDI order': 'Opprett bestilling',
  'New car – no PDI order yet. Register what the customer ordered and send it to the workshop.': 'Ny bil – ingen bestilling av nybilklargjøring ennå. Registrer hva kunden har bestilt og send det til verkstedet.',
  'Not sent': 'Ikke sendt', 'Sent – waiting for date': 'Sendt – venter på dato', 'PDI done': 'Nybilklargjøring utført',
  'Changed since it was sent — send it again so the workshop has the latest order.': 'Endret etter at den ble sendt — send på nytt så verkstedet har siste versjon.',
  'PDI date is set, but the order list has not been sent to the workshop yet.': 'Dato er satt, men bestillingen er ikke sendt til verkstedet ennå.',
  'Nothing ordered yet.': 'Ingenting bestilt ennå.', 'Cancel order': 'Avbryt bestilling', 'Edit order': 'Rediger bestilling', 'Send again…': 'Send på nytt…',
  'Send to workshop…': 'Send til verkstedet…', 'Change PDI date': 'Endre dato', 'Enter PDI date': 'Legg inn dato', '✓ PDI done': '✓ Nybilklargjøring utført',
  'Ordered by the customer': 'Bestilt av kunden', 'Anything else the customer ordered': 'Annet kunden har bestilt', 'Winter tyres': 'Vinterdekk',
  'Choose tyre company…': 'Velg dekkleverandør…', 'Tyre company (the workshop orders from)': 'Dekkleverandør (verkstedet bestiller fra)', 'Tyre company (optional)': 'Dekkleverandør (valgfritt)',
  'Expected delivery date': 'Forventet leveringsdato', 'Tyre details (optional)': 'Dekkdetaljer (valgfritt)', 'Dimension, rims, studded/unstudded…': 'Dimensjon, felger, piggdekk/piggfritt…',
  'Note to the workshop (optional)': 'Merknad til verkstedet (valgfritt)', 'Save order': 'Lagre bestilling', 'PDI order saved': 'Bestilling lagret', 'New PDI order': 'Ny bestilling av nybilklargjøring',
  'Edit PDI order': 'Rediger bestilling av nybilklargjøring', 'Send PDI order': 'Send bestilling av nybilklargjøring', 'Send to': 'Send til', 'Loading': 'Laster',
  'Send from Carbonara': 'Send fra Carbonara', 'Open in e-mail app': 'Åpne i e-postprogram', 'Copy text': 'Kopier tekst', 'Marked as sent': 'Merket som sendt',
  'Did you send the e-mail from your e-mail app?': 'Sendte du e-posten fra e-postprogrammet ditt?', 'Copy not allowed here – select the text instead': 'Kopiering er ikke tillatt her – merk teksten i stedet',
  'Sending directly from Carbonara is not set up yet (a system admin can add the mail server on the System page → E-mail), so use your own e-mail app.':
    'Sending direkte fra Carbonara er ikke satt opp ennå (en systemadministrator kan legge inn e-postserver under System → E-post), så bruk ditt eget e-postprogram.',
  'No e-mail recipients yet. An administrator can add them under Settings → PDI order lists.': 'Ingen e-postmottakere ennå. En administrator kan legge dem til under Innstillinger → Lister for nybilklargjøring.',
  'PDI date and time': 'Dato og klokkeslett for nybilklargjøring', 'Save PDI date': 'Lagre dato', 'Remove date': 'Fjern dato', 'PDI date saved': 'Dato lagret',
  'Enter the date and time the workshop replied with. Everyone sees it on the Today page, with a reminder the day before.':
    'Legg inn datoen og klokkeslettet verkstedet svarte med. Alle ser det på I dag-siden, med påminnelse dagen før.',
  'Mark the PDI as done?': 'Merke nybilklargjøringen som utført?', 'PDI marked as done': 'Nybilklargjøring merket som utført', 'Cancel this PDI order?': 'Avbryte denne bestillingen?',
  'Cancel this PDI order? It has already been sent – remember to tell the workshop.': 'Avbryte denne bestillingen? Den er allerede sendt – husk å gi beskjed til verkstedet.',
  // ---- storage maintenance
  'Storage maintenance': 'Lagervedlikehold', 'not done yet': 'ikke utført ennå', 'due today': 'frist i dag',
  // used cars: 12V charging every month
  '12V battery charging due (used cars)': '12V-lading som forfaller (bruktbiler)', 'not charged since it came into storage': 'ikke ladet siden den kom på lager',
  '12V battery charging': '12V-batterilading', 'Used cars in storage: charge the 12V battery every month.': 'Bruktbiler på lager: lad 12V-batteriet hver måned.',
  'Next charge': 'Neste lading', 'Record charge': 'Registrer lading', 'Record 12V charge': 'Registrer 12V-lading', 'The voltages are optional.': 'Spenningene er valgfrie.',
  'Charge cancelled': 'Lading annullert', '12V charge saved': '12V-lading lagret', '12V battery charged': '12V-batteri ladet', '12V charge cancelled': '12V-lading annullert',
  'Monthly 12V charging is recorded for used cars': 'Månedlig 12V-lading registreres for bruktbiler', 'This charge is already cancelled': 'Denne ladingen er allerede annullert',
  'Battery charge': 'Batterilading', 'No photo': 'Ingen bilde', 'Open inspection': 'Åpne kontrollen',
  // arrival inspection: cancel and delete / pause
  'Cancel inspection and delete': 'Avbryt kontroll og slett', 'Pause inspection': 'Sett kontrollen på pause',
  'Inspection cancelled and car deleted': 'Kontrollen er avbrutt og bilen slettet',
  'Cancel this arrival inspection and delete the car?\n\nThe car goes to Recently deleted and can be restored from Settings for a while.':
    'Avbryte mottakskontrollen og slette bilen?\n\nBilen flyttes til Nylig slettet og kan gjenopprettes fra Innstillinger en stund.',
  'Cancel this arrival inspection? The car was here before, so it is kept; the inspection stays in its history as cancelled.':
    'Avbryte mottakskontrollen? Bilen har vært her før, så den beholdes; kontrollen blir stående i historikken som avbrutt.',
  // documents per car
  'Add document': 'Legg til dokument', 'Edit document': 'Rediger dokument',
  'Contract': 'Kontrakt', 'Other document': 'Annet dokument', 'Title': 'Tittel', 'E.g. Purchase contract': 'F.eks. kjøpekontrakt',
  'File (PDF, photo, Word, Excel or text)': 'Fil (PDF, bilde, Word, Excel eller tekst)', 'Text / note': 'Tekst / notat',
  'The file itself can’t be replaced; delete the document and add it again.': 'Selve filen kan ikke byttes; slett dokumentet og legg det til på nytt.',
  'Add a file, write a text, or both. On a phone you can take a photo of a paper contract.': 'Legg til en fil, skriv en tekst, eller begge deler. På mobil kan du ta bilde av en papirkontrakt.',
  'Add a file or write a text': 'Legg til en fil eller skriv en tekst', 'Document saved': 'Dokument lagret', 'Document deleted': 'Dokument slettet',
  'No documents yet. Add contracts, notes or other files for this car.': 'Ingen dokumenter ennå. Legg til kontrakter, notater eller andre filer for denne bilen.',
  'Document added': 'Dokument lagt til', 'Document changed': 'Dokument endret', 'Document': 'Dokument', 'Document file': 'Dokumentfil',
  'This file type is not allowed (use PDF, a photo, Word, Excel or text)': 'Denne filtypen er ikke tillatt (bruk PDF, bilde, Word, Excel eller tekst)',
  'File too large': 'Filen er for stor', 'The file is empty': 'Filen er tom', 'A document without a file needs a text': 'Et dokument uten fil må ha en tekst',
  'The title is too long (max 200 characters)': 'Tittelen er for lang (maks 200 tegn)', 'The text is too long (max 10 000 characters)': 'Teksten er for lang (maks 10 000 tegn)',
  'Only the person who added it or an administrator can change this document': 'Bare den som la det til eller en administrator kan endre dette dokumentet',
  '🖨 Storage report': '🖨 Lagerrapport', 'Storage report': 'Lagerrapport', 'Only 12V battery form': 'Bare 12V-batteriskjema', '🖨 Print / save as PDF': '🖨 Skriv ut / lagre som PDF',
  'Checklist': 'Sjekkliste', 'Mark all OK': 'Merk alle OK', 'Tyre pressure': 'Dekktrykk', 'Measured (bar)': 'Målt (bar)', '12V battery (tester)': '12V-batteri (tester)',
  'Voltage on arrival (V)': 'Spenning ved mottak (V)', 'Voltage before charging (V)': 'Spenning før lading (V)', 'Battery status': 'Batteristatus', 'Tester result…': 'Testresultat…',
  'Voltage after charging (V)': 'Spenning etter lading (V)', 'Battery part number': 'Delenummer batteri', 'From the battery label': 'Fra batterietiketten', 'HV battery': 'HV-batteri',
  'State of charge (SOC %)': 'Ladenivå (SOC %)', 'Required if something is not OK: what was found and what was done': 'Påkrevd hvis noe ikke er OK: hva som ble funnet og hva som ble gjort',
  'Signed with your name and the time when saved.': 'Signeres med navnet ditt og tidspunktet når det lagres.', 'Save check': 'Lagre kontroll',
  'A point is not OK – describe it under Remarks.': 'Et punkt er ikke OK – beskriv det under Anmerkninger.', 'Battery tester did not say “Good” – charge or replace.': 'Batteritesteren viste ikke «God» – lad eller bytt.',
  'Check cancelled': 'Kontroll annullert', 'Give a reason (at least 3 characters)': 'Oppgi en begrunnelse (minst 3 tegn)',
  // ---- settings
  'Staff / inspectors': 'Ansatte / kontrollører', 'Only an administrator can add staff or change PINs.': 'Bare en administrator kan legge til ansatte eller endre PIN-koder.',
  'Everyone logs in with a personal PIN. Give new staff a PIN here; reset it if someone forgets theirs (that also unlocks the account and logs out their devices).':
    'Alle logger inn med personlig PIN-kode. Gi nye ansatte en PIN-kode her; tilbakestill den hvis noen glemmer sin (det låser også opp kontoen og logger ut enhetene deres).',
  'Set PIN': 'Sett PIN-kode', 'Reset PIN': 'Tilbakestill PIN-kode', 'Make admin': 'Gjør til admin', 'Remove admin': 'Fjern admin', 'Make system admin': 'Gjør til systemadministrator',
  'Remove system admin': 'Fjern systemadministrator', 'No PIN — can’t log in': 'Ingen PIN-kode — kan ikke logge inn', 'PIN (4–8 digits)': 'PIN-kode (4–8 sifre)', 'Save PIN': 'Lagre PIN-kode',
  'The PIN must be 4–8 digits': 'PIN-koden må være 4–8 sifre', 'Storage spots': 'Lagerplasser', 'Add a spot': 'Legg til en plass', 'Code, e.g. A-12': 'Kode, f.eks. A-12',
  'Zone, e.g. Yard A': 'Sone, f.eks. Uteplass A', 'Description (optional)': 'Beskrivelse (valgfritt)', 'Max cars (empty = no limit)': 'Maks biler (tom = ingen grense)', 'Add spot': 'Legg til plass',
  'Add a numbered range': 'Legg til en nummerert rekke', 'Prefix, e.g. A-': 'Prefiks, f.eks. A-', 'Add range': 'Legg til rekke', 'Range must be 1–500 spots': 'Rekken må være 1–500 plasser',
  '+ Sub-zone': '+ Undersone', 'Sub-zone name': 'Navn på undersone', 'Max cars': 'Maks biler', 'Empty = no limit': 'Tom = ingen grense', 'Add sub-zone': 'Legg til undersone',
  'Sum of the sub-zones': 'Sum av undersonene', 'Split a spot into sub-zones (rows, areas) with "+ Sub-zone"; cars are then placed in a sub-zone.': 'Del en plass i undersoner (rader, områder) med «+ Undersone»; bilene plasseres da i en undersone.',
  'Choose a spot…': 'Velg en plass…', 'Each move is written to the car’s history.': 'Hver flytting skrives i bilens historikk.', 'See the cars': 'Se bilene',
  'PDI order lists': 'Lister for nybilklargjøring', 'Only an administrator can change these lists.': 'Bare en administrator kan endre disse listene.',
  'Items the customer can order': 'Utstyr kunden kan bestille', 'Shown as tick boxes on the PDI order. Names go to the workshop as written (Norwegian is fine).': 'Vises som avkrysningsbokser på bestillingen. Navnene sendes til verkstedet slik de er skrevet.',
  'Item, e.g. Takboks': 'Utstyr, f.eks. Takboks', 'Choices (optional), e.g. Gummi, Tekstil': 'Valg (valgfritt), f.eks. Gummi, Tekstil', 'Tyre companies': 'Dekkleverandører',
  'Who the workshop orders winter tyres from.': 'Hvem verkstedet bestiller vinterdekk fra.', 'Tyre company': 'Dekkleverandør', 'E-mail recipients': 'E-postmottakere',
  'Who PDI orders can be sent to. The default is preselected when sending.': 'Hvem bestillinger kan sendes til. Standardmottakeren er forhåndsvalgt ved sending.',
  'Name, e.g. the workshop': 'Navn, f.eks. verkstedet', 'E-mail address': 'E-postadresse', 'Make default': 'Gjør til standard', ' Default': ' Standard',
  'Choices, separated by commas (empty = none)': 'Valg, skilt med komma (tom = ingen)', 'Statens vegvesen sync': 'Synkronisering med Statens vegvesen', 'Synced OK': 'Synkronisert OK',
  'Not found in registry': 'Ikke funnet i registeret', 'Due for sync now': 'Klar for synkronisering nå', 'No API key configured yet.': 'Ingen API-nøkkel satt ennå.',
  'To add or replace the key: ': 'For å legge inn eller bytte nøkkelen: ', 'A system admin can add or replace the key on the System page.': 'En systemadministrator kan legge inn eller bytte nøkkelen på System-siden.',
  'Data retention': 'Lagring av data', 'Deleted cars stay in ': 'Slettede biler ligger i ', 'Automatic deletion of old cars is turned off.': 'Automatisk sletting av gamle biler er slått av.',
  'Change the periods on the ': 'Endre periodene på ', 'A system admin can change the periods on the System page.': 'En systemadministrator kan endre periodene på System-siden.',
  // ---- system page
  'Only a system admin can open this page.': 'Bare en systemadministrator kan åpne denne siden.', 'Set here': 'Satt her', 'From server environment': 'Fra servermiljøet',
  'Server settings. A value saved here takes effect within half a minute and overrides the server environment (.env / Portainer). ':
    'Serverinnstillinger. En verdi lagret her gjelder innen et halvt minutt og overstyrer servermiljøet (.env / Portainer). ',
  '“Reset” goes back to the environment or the default. Passwords and keys are never shown – only their last characters.':
    '«Tilbakestill» går tilbake til servermiljøet eller standardverdien. Passord og nøkler vises aldri – bare de siste tegnene.',
  'Type a value first (or use Reset)': 'Skriv inn en verdi først (eller bruk Tilbakestill)', 'E-mail': 'E-post', 'Company': 'Firma',
  'API key': 'API-nøkkel', 'Re-sync registered cars every (days)': 'Synkroniser registrerte biler hver (dag)', 'API address': 'API-adresse',
  'Auth header name': 'Navn på autentiseringsheader', 'Auth scheme': 'Autentiseringsskjema', 'Pause between API calls (seconds)': 'Pause mellom API-kall (sekunder)',
  'Mail server (SMTP host)': 'E-postserver (SMTP-vert)', 'Port': 'Port', 'Security': 'Sikkerhet', 'Username': 'Brukernavn', 'Password': 'Passord', 'Sender': 'Avsender',
  'Company name': 'Firmanavn', 'Dealer number (Forh. nr.)': 'Forhandlernummer (Forh. nr.)', 'Contact for customers': 'Kontakt for kunder',
  'Phone for customers': 'Telefon for kunder', 'E-mail for customers': 'E-post for kunder', 'Postal address': 'Postadresse',
  'Shown to test drive customers on the privacy notice.': 'Vises for prøvekjøringskunder i personvernerklæringen.',
  'Shown on the privacy notice: street, postcode and town.': 'Vises i personvernerklæringen: gate, postnummer og sted.',
  'e.g. Company name <post@example.com>': 'f.eks. Firmanavn <post@example.com>',
  'Customer deliveries (kiosk)': 'Kundeleveringer (kiosk)', "Shown on the kiosk's privacy notice.": 'Vises i personvernerklæringen på kiosken.',
  "Responsible for the data on the kiosk's privacy notice. Empty = the Company details above are used.": 'Ansvarlig for opplysningene i personvernerklæringen på kiosken. Tomt = firmaopplysningene over brukes.',
  'Keep deleted data (days)': 'Behold slettede data (dager)', 'Delete inactive off-site cars after (years)': 'Slett inaktive biler utenfor lageret etter (år)',
  "Key for 'API for tekniske kjøretøyopplysninger' (apply at vegvesen.no).": "Nøkkel for 'API for tekniske kjøretøyopplysninger' (søk på vegvesen.no).",
  'Only change if Statens vegvesen changes their API.': 'Endres bare hvis Statens vegvesen endrer API-et sitt.',
  'Empty = not set up; staff send from their own e-mail app. Gmail: smtp.gmail.com': 'Tom = ikke satt opp; ansatte sender fra eget e-postprogram. Gmail: smtp.gmail.com',
  'starttls for port 587, ssl for port 465.': 'starttls for port 587, ssl for port 465.', 'Gmail: an app password, not the normal password.': 'Gmail: et app-passord, ikke det vanlige passordet.',
  'Shown on the privacy notice, PDI e-mails and storage reports.': 'Vises i personvernerklæringen, e-post om nybilklargjøring og lagerrapporter.',
  'Printed on the storage maintenance report.': 'Skrives ut på lagerrapporten.', 'E-mail and/or phone shown to test drive customers on the privacy notice.': 'E-post og/eller telefon som vises for prøvekjøringskunder i personvernerklæringen.',
  'Recently deleted cars and returned test drive customers.': 'Nylig slettede biler og kunder fra avsluttede prøvekjøringer.', '0 = never.': '0 = aldri.',
  // ---- login
  'Who are you?': 'Hvem er du?', 'Log in with your personal PIN.': 'Logg inn med din personlige PIN-kode.', 'PIN': 'PIN-kode', 'Choose your name…': 'Velg navnet ditt…',
  'Your name': 'Navnet ditt', 'First-time setup. ': 'Førstegangsoppsett. ', 'Choose your name and a PIN. You become the administrator and can give the others their PINs under Settings.':
    'Velg navnet ditt og en PIN-kode. Du blir administrator og kan gi de andre PIN-koder under Innstillinger.', 'Choose a PIN (4–8 digits)': 'Velg en PIN-kode (4–8 sifre)',
  'Repeat the PIN': 'Gjenta PIN-koden', 'Set PIN and log in': 'Sett PIN-kode og logg inn', 'Nobody has a PIN yet. Ask an administrator.': 'Ingen har PIN-kode ennå. Spør en administrator.',
  'The two PINs are not the same': 'De to PIN-kodene er ikke like', 'Change PIN': 'Endre PIN-kode', 'Current PIN': 'Nåværende PIN-kode', 'New PIN (4–8 digits)': 'Ny PIN-kode (4–8 sifre)',
  'Repeat new PIN': 'Gjenta ny PIN-kode', 'Your other devices are logged out.': 'De andre enhetene dine logges ut.', 'The two new PINs are not the same': 'De to nye PIN-kodene er ikke like',
  'PIN changed': 'PIN-kode endret', 'Language': 'Språk', 'Theme': 'Tema', 'Same as device': 'Som enheten', 'Light': 'Lyst', 'Dark': 'Mørkt', 'Staff ': 'Ansatt ',
  // ---- date/time fields
  'dd.mm.yyyy': 'dd.mm.åååå', 'hh:mm': 'tt:mm', 'Use the format dd.mm.yyyy': 'Bruk formatet dd.mm.åååå', 'Use 24-hour time, e.g. 08:00 or 14:30': 'Bruk 24-timers tid, f.eks. 08:00 eller 14:30',
  // ---- registry detail labels (from the server)
  'Vehicle ': 'Kjøretøy ', 'Approval': 'Godkjenning', 'Body': 'Karosseri', 'Class': 'Klasse', 'CO₂': 'CO₂', 'Curb weight': 'Egenvekt', 'Current owner since': 'Nåværende eier siden',
  'Doors': 'Dører', 'Drivetrain and environment': 'Drivlinje og miljø', 'Energy use': 'Energiforbruk', 'Engine': 'Motor', 'Engine code': 'Motorkode', 'EU type approval': 'EU-typegodkjenning',
  'Euro class': 'Euroklasse', 'First registered': 'Første gang registrert', 'First registered in Norway': 'Første gang registrert i Norge', 'Fuel consumption': 'Drivstofforbruk',
  'Gearbox': 'Girkasse', 'Length × width × height': 'Lengde × bredde × høyde', 'Manufacturer': 'Produsent', 'Max total weight': 'Tillatt totalvekt', 'Max train weight': 'Tillatt vogntogvekt',
  'Payload': 'Nyttelast', 'Plate type': 'Skilttype', 'Power': 'Effekt', 'Range (WLTP)': 'Rekkevidde (WLTP)', 'Seats': 'Sitteplasser', 'Status': 'Status', 'Top speed': 'Toppfart',
  'Towing': 'Tilhenger', 'Trailer with brakes': 'Tilhenger med brems', 'Trailer without brakes': 'Tilhenger uten brems', 'Type designation': 'Typebetegnelse',
  'Type plate location': 'Plassering typeskilt', 'Tyres and rims': 'Dekk og felger', 'Weights and towing': 'Vekter og tilhenger',
  // ---- server messages
  'Not logged in': 'Ikke innlogget', 'Wrong name or PIN': 'Feil navn eller PIN-kode', 'Wrong PIN': 'Feil PIN-kode', 'Current PIN is wrong': 'Nåværende PIN-kode er feil',
  'Only a system admin can do this': 'Bare en systemadministrator kan gjøre dette', 'Only an administrator can do this': 'Bare en administrator kan gjøre dette',
  'Only a system admin can give or remove system admin': 'Bare en systemadministrator kan gi eller fjerne systemadministrator', 'Only a system admin can change another system admin': 'Bare en systemadministrator kan endre en annen systemadministrator',
  "You can't deactivate yourself or remove your own rights": 'Du kan ikke deaktivere deg selv eller fjerne dine egne rettigheter', 'Setup is already done. Log in instead.': 'Oppsettet er allerede gjort. Logg inn i stedet.',
  'Choose your name, or type it in': 'Velg navnet ditt, eller skriv det inn', 'Staff member not found': 'Ansatt ikke funnet', 'Unknown or inactive staff member': 'Ukjent eller inaktiv ansatt',
  'Unknown or inactive storage location': 'Ukjent eller inaktiv lagerplass', 'Choose a spot outside the one you are deleting': 'Velg en plass utenfor den du sletter',
  'Sub-zones can only be added to a top-level spot, not to another sub-zone': 'Undersoner kan bare legges til en hovedplass, ikke til en annen undersone',
  'The car is already off site': 'Bilen er allerede utenfor lageret', 'This vehicle is already in stock': 'Denne bilen er allerede på lager',
  'Finish the arrival inspection first; it places the car in storage': 'Fullfør mottakskontrollen først; den plasserer bilen på lager',
  'Damages are recorded; remove them before confirming \'no damage\'': 'Det er registrert skader; fjern dem før du bekrefter «ingen skader»',
  'This damage is already marked as repaired': 'Denne skaden er allerede merket som reparert', 'This damage is not marked as repaired': 'Denne skaden er ikke merket som reparert',
  'Photo does not belong to this inspection': 'Bildet hører ikke til denne kontrollen', 'File is not a readable image': 'Filen er ikke et lesbart bilde', 'Image too large': 'Bildet er for stort',
  'VIN must be 17 characters: A–Z and 0–9, without I, O or Q': 'VIN må være 17 tegn: A–Z og 0–9, uten I, O eller Q',
  'This VIN was registered at the same moment by someone else; try again': 'Denne VIN-en ble registrert samtidig av noen andre; prøv igjen',
  "A car with this VIN has been added again since; it can't be restored": 'En bil med denne VIN-en er lagt inn på nytt siden; den kan ikke gjenopprettes',
  'Give a VIN or a registration number': 'Oppgi VIN eller registreringsnummer', 'Vehicle is already marked as registered': 'Bilen er allerede merket som registrert',
  'Vehicle is not marked as registered': 'Bilen er ikke merket som registrert', 'Mark the vehicle as registered before syncing with Statens vegvesen': 'Merk bilen som registrert før synkronisering med Statens vegvesen',
  'Statens vegvesen API key is not configured on the server': 'API-nøkkelen til Statens vegvesen er ikke satt på serveren', 'Not found in the vehicle registry': 'Ikke funnet i kjøretøyregisteret',
  'Rate limit / daily quota reached': 'Grensen for antall oppslag er nådd', 'Response did not contain this VIN': 'Svaret inneholdt ikke denne VIN-en', 'Response was not JSON': 'Svaret var ikke JSON',
  'Customer name is required': 'Kundens navn er påkrevd', 'Phone number: 8–15 digits, optionally starting with +': 'Telefonnummer: 8–15 sifre, eventuelt med + foran',
  'Odometer reading is not valid': 'Kilometerstanden er ikke gyldig', 'This car is already out on a test drive': 'Denne bilen er allerede ute på prøvekjøring',
  'The car is out on a test drive. Register it as returned first.': 'Bilen er ute på prøvekjøring. Registrer den som levert tilbake først.',
  'This test drive is already returned': 'Denne prøvekjøringen er allerede levert tilbake', 'Return the car before deleting the customer details': 'Lever bilen tilbake før kundeopplysningene slettes',
  'Confirm that the items are back in place, or write a note about what is missing': 'Bekreft at utstyret er på plass igjen, eller skriv hva som mangler',
  'Confirm that the customer has been given the privacy information': 'Bekreft at kunden har fått personverninformasjonen',
  'Choose the tyre company the workshop should order from': 'Velg dekkleverandøren verkstedet skal bestille fra', 'Give the expected delivery date for the tyres': 'Oppgi forventet leveringsdato for dekkene',
  'This PDI order is closed': 'Denne bestillingen er avsluttet', 'Unknown recipient': 'Ukjent mottaker', 'Give a valid e-mail address': 'Oppgi en gyldig e-postadresse',
  'E-mail sending is not set up on the server (SMTP_HOST / SMTP_FROM)': 'Sending av e-post er ikke satt opp på serveren (SMTP_HOST / SMTP_FROM)',
  'Empty value: use Reset to go back to the server environment / default': 'Tom verdi: bruk Tilbakestill for å gå tilbake til servermiljøet / standard',
  'Enter the tyre pressure': 'Legg inn dekktrykket', 'Enter the 12V voltage and the battery tester result': 'Legg inn 12V-spenningen og resultatet fra batteritesteren',
  'Enter the voltage after charging': 'Legg inn spenningen etter lading', 'Enter the HV battery charge (SOC %)': 'Legg inn ladenivået på HV-batteriet (SOC %)',
  'Something is not OK – describe it and what was done under Remarks': 'Noe er ikke OK – beskriv det og hva som ble gjort under Anmerkninger',
  'The page is out of date – reload and try again': 'Siden er utdatert – last inn på nytt og prøv igjen', 'This check is already cancelled': 'Denne kontrollen er allerede annullert',
  'Give a reason': 'Oppgi en begrunnelse', 'No storage check is due for this car': 'Ingen lagerkontroll forfaller for denne bilen',
  'The storage programme is for factory-new cars.': 'Lagerprogrammet gjelder fabrikknye biler.', 'PDI done – storage programme finished.': 'Nybilklargjøring utført – lagerprogrammet er avsluttet.',
  'The car is off site.': 'Bilen er ikke på lager.', 'Starts when the car is placed in storage.': 'Starter når bilen plasseres på lager.',
  'First storage check done – the monthly checks start when the car is placed in storage.': 'Første lagerkontroll utført – de månedlige kontrollene starter når bilen plasseres på lager.',
  'Licence photo': 'Førerkortbilde', 'Licence photo file': 'Førerkortbildefil', 'Photo file': 'Bildefil', 'Photo variant': 'Bildevariant', 'Storage location': 'Lagerplass',
  'Parent spot': 'Hovedplass', 'Staff member': 'Ansatt', 'Inspection': 'Kontroll', 'List entry': 'Listeelement', 'Setting': 'Innstilling', 'Storage check ': 'Lagerkontroll ',

  // ---- customer car delivery (kiosk)
  'Deliver your car': 'Lever bilen din', 'Register the car you are leaving with us. It only takes a minute.': 'Registrer bilen du leverer hos oss. Det tar bare et minutt.',
  'Registration number': 'Registreringsnummer', 'Where did you leave the key?': 'Hvor la du nøkkelen?', 'Where is the car parked?': 'Hvor står bilen parkert?',
  'Tap the map where you parked the car.': 'Trykk på kartet der du parkerte bilen.', 'Tick what applies': 'Kryss av for det som gjelder',
  'Message to the workshop (optional)': 'Melding til verkstedet (valgfritt)', 'Read the privacy notice': 'Les personvernerklæringen',
  'Register delivery': 'Registrer levering', 'Choose where you left the key': 'Velg hvor du la nøkkelen', 'Choose where the car is parked': 'Velg hvor bilen står parkert',
  'Tap the map where the car is parked': 'Trykk på kartet der bilen står parkert', 'Thank you!': 'Takk!', 'We have registered your car': 'Vi har registrert bilen din',
  'Remember to leave the key here': 'Husk å legge nøkkelen her', 'We will contact you if we have any questions.': 'Vi kontakter deg hvis vi har spørsmål.', 'Done': 'Ferdig',
  'Staff login': 'Innlogging for ansatte', 'Back to the delivery form': 'Tilbake til leveringsskjemaet',
  'Preview of the kiosk form. A delivery sent from here is real and shows up for the staff.': 'Forhåndsvisning av kiosk-skjemaet. En levering sendt herfra er ekte og vises for de ansatte.',
  'Back to Customer deliveries': 'Tilbake til Kundeleveringer', 'Customer deliveries': 'Kundeleveringer', 'Open the kiosk form': 'Åpne kiosk-skjemaet',
  'No customer cars waiting.': 'Ingen kundebiler venter.', 'None.': 'Ingen.', 'Received': 'Mottatt', 'Show': 'Vis', 'Key': 'Nøkkel', 'Parked': 'Parkert',
  'Enlarge the map': 'Forstørr kartet',
  'An administrator sets up the kiosk (maps, key places, tick boxes, tablets) on this page.': 'En administrator setter opp kiosken (kart, nøkkelsteder, avkrysningsbokser, nettbrett) på denne siden.',
  'Kiosk setup': 'Oppsett av kiosk', 'Maps (locations)': 'Kart (steder)', 'Location name, e.g. Main lot': 'Navn på stedet, f.eks. Hovedplassen',
  'Norwegian name (optional)': 'Norsk navn (valgfritt)', 'Add map': 'Legg til kart', 'Map added': 'Kart lagt til', 'Used by 1 delivery': 'Brukt av 1 levering',
  'One picture per location: a drone photo, a screenshot of the lot or a simple drawing, seen from above. Customers tap where they parked. With several maps, they choose the location first. To change a picture, add a new map and remove the old one. Pictures from map services (Google, norgeskart.no) may have licence terms.':
    'Ett bilde per sted: et dronebilde, et skjermbilde av plassen eller en enkel tegning, sett ovenfra. Kundene trykker der de parkerte. Med flere kart velger de stedet først. For å bytte bilde legger du til et nytt kart og fjerner det gamle. Bilder fra karttjenester (Google, norgeskart.no) kan ha lisensvilkår.',
  'Name (English)': 'Navn (engelsk)', 'Name (Norwegian, optional)': 'Navn (norsk, valgfritt)',
  'No maps yet. Without a map, customers are not asked where the car is parked.': 'Ingen kart ennå. Uten kart blir ikke kundene spurt om hvor bilen står.',
  'English text': 'Engelsk tekst', 'Norwegian text': 'Norsk tekst', 'Key places': 'Nøkkelsteder', 'Tick boxes': 'Avkrysningsbokser',
  'Where customers can leave the key. They choose one. Each text in English and Norwegian (the customer’s language is shown).':
    'Hvor kundene kan legge nøkkelen. De velger ett. Hver tekst på engelsk og norsk (kundens språk vises).',
  'Tick boxes on the form, e.g. what the car is in for. Customers tick any number. Each text in English and Norwegian.':
    'Avkrysningsbokser på skjemaet, f.eks. hva bilen skal ha gjort. Kundene krysser av så mange de vil. Hver tekst på engelsk og norsk.',
  'No key places. Customers are not asked where the key is.': 'Ingen nøkkelsteder. Kundene blir ikke spurt om hvor nøkkelen er.', 'No tick boxes.': 'Ingen avkrysningsbokser.',
  'Kiosk tablets': 'Kiosk-nettbrett', 'Stopped': 'Stoppet', 'Stop': 'Stopp', 'No kiosk tablets yet.': 'Ingen kiosk-nettbrett ennå.',
  'A kiosk tablet shows only the delivery form, with no login. To set one up, log in on the tablet as an administrator, open this page and press the button below. You are then logged out on the tablet.':
    'Et kiosk-nettbrett viser bare leveringsskjemaet, uten innlogging. For å sette opp et: logg inn på nettbrettet som administrator, åpne denne siden og trykk på knappen under. Du blir da logget ut på nettbrettet.',
  'Use this device as the delivery kiosk': 'Bruk denne enheten som leveringskiosk', 'Delivery kiosk': 'Leveringskiosk', 'Name of this device': 'Navn på denne enheten',
  'e.g. Tablet at the key drop': 'f.eks. Nettbrett ved nøkkelinnleveringen', 'Make this device a kiosk': 'Gjør denne enheten til kiosk',
  'This device will show only the customer delivery form. You are logged out here, and the rest of Carbonara can only be opened again by logging in (the "Staff login" link at the bottom of the form).':
    'Denne enheten vil bare vise leveringsskjemaet for kunder. Du blir logget ut her, og resten av Carbonara kan bare åpnes igjen ved å logge inn (lenken «Innlogging for ansatte» nederst i skjemaet).',
  'Customer cars delivered – not received yet': 'Kundebiler levert – ikke mottatt ennå', 'All customer deliveries': 'Alle kundeleveringer',
  'Customer car delivery': 'Levering av kundebil', 'Open Customer deliveries': 'Åpne Kundeleveringer',
  'The kiosk form where customers register the car they drop off: maps, key places, tick boxes and kiosk tablets.':
    'Kiosk-skjemaet der kundene registrerer bilen de leverer: kart, nøkkelsteder, avkrysningsbokser og kiosk-nettbrett.',
  'Delivered by the customer (kiosk)': 'Levert av kunden (kiosk)', 'Customer delivery received': 'Kundelevering mottatt',
  'Look up again': 'Slå opp på nytt', 'Name from Statens vegvesen': 'Navn fra Statens vegvesen', 'Typed by the customer': 'Skrevet av kunden',
  'Similar to the typed name': 'Ligner på navnet kunden skrev', 'Different from the typed name': 'Ulikt navnet kunden skrev', 'Company car': 'Firmabil',
  'Not found at Statens vegvesen – check the registration number': 'Ikke funnet hos Statens vegvesen – sjekk registreringsnummeret',
  'Statens vegvesen lookup failed': 'Oppslaget hos Statens vegvesen feilet', 'Statens vegvesen is not set up (System page)': 'Statens vegvesen er ikke satt opp (System-siden)',
  'Not looked up at Statens vegvesen yet': 'Ikke slått opp hos Statens vegvesen ennå', 'Lookup failed': 'Oppslaget feilet',
  'no deadline from Statens vegvesen': 'ingen frist fra Statens vegvesen',
  // ---- teams (System page)
  'Teams': 'Team', 'Add team': 'Legg til team', 'Team added': 'Team lagt til', 'No teams yet.': 'Ingen team ennå.', 'No members.': 'Ingen medlemmer.',
  'Remove from team': 'Fjern fra teamet', 'Add a user': 'Legg til en bruker', 'Add a user to the team': 'Legg til en bruker i teamet',
  'Team name': 'Teamnavn', 'New team name, e.g. Sales': 'Navn på nytt team, f.eks. Salg', 'Team': 'Team',
  'Menu items this team sees (Today is always shown)': 'Menypunkter dette teamet ser (I dag vises alltid)',
  'System admin – sees everything': 'Systemadministrator – ser alt',
  'Each user is in one team. The team decides which items they see in the top menu; other pages show “not available”. Users without a team see only Today. System admins always see everything. A change takes effect the next time the user opens or reloads Carbonara.':
    'Hver bruker er i ett team. Teamet bestemmer hvilke punkter brukeren ser i toppmenyen; andre sider viser «ikke tilgjengelig». Brukere uten team ser bare I dag. Systemadministratorer ser alltid alt. En endring gjelder neste gang brukeren åpner eller laster Carbonara på nytt.',
  'Not available': 'Ikke tilgjengelig',
  'This page is not available for your team. Ask a system admin if you need it.': 'Denne siden er ikke tilgjengelig for teamet ditt. Spør en systemadministrator hvis du trenger den.',
  'Give the team a name': 'Gi teamet et navn',
  // server messages
  'This device is not set up as a delivery kiosk': 'Denne enheten er ikke satt opp som leveringskiosk',
  'Registration number: 2–8 letters and digits': 'Registreringsnummer: 2–8 bokstaver og sifre', 'This delivery is already received': 'Denne leveringen er allerede mottatt',
  'Mark the car as received before deleting the delivery': 'Merk bilen som mottatt før du sletter leveringen',
  'Give both the English and the Norwegian text': 'Oppgi både engelsk og norsk tekst', 'Give the location a name': 'Gi stedet et navn',
  'Deliveries point to this map, so it can only be removed, not deleted': 'Leveringer viser til dette kartet, så det kan bare fjernes, ikke slettes',
  'Give the kiosk a name': 'Gi kiosken et navn', 'Delivery': 'Levering', 'Map': 'Kart', 'Map file': 'Kartfil', 'Kiosk': 'Kiosk',
  // ---- rental cars
  'Rental cars': 'Leiebiler', 'Rent out a car': 'Lei ut en bil', 'Rent out': 'Lei ut', 'Add rental car': 'Legg til leiebil',
  '+ Add rental car': '+ Legg til leiebil', 'Available': 'Ledig', 'Rented out': 'Utleid', 'Out on rental': 'Utleid',
  'Look up at Statens vegvesen': 'Slå opp hos Statens vegvesen', 'VIN (optional)': 'Understellsnummer (valgfritt)',
  'Expected back (optional)': 'Ventes tilbake (valgfritt)', 'Expected back': 'Ventes tilbake',
  'Not returned – expected back': 'Ikke levert – ventet tilbake',
  'Rental car added': 'Leiebil lagt til', 'Rental car saved': 'Leiebil lagret', 'Rental car removed': 'Leiebil fjernet',
  '✓ Found at Statens vegvesen': '✓ Funnet hos Statens vegvesen', 'Type the registration number first': 'Skriv inn registreringsnummeret først',
  'EU-kontroll soon: ': 'EU-kontroll snart: ', 'No rental cars are out.': 'Ingen leiebiler er utleid.',
  'All rental cars are out.': 'Alle leiebilene er utleid.', 'Add a rental car below first.': 'Legg til en leiebil nedenfor først.',
  'No rental cars yet. Add the first one with “+ Add rental car”.': 'Ingen leiebiler ennå. Legg til den første med «+ Legg til leiebil».',
  'Statens vegvesen: ': 'Statens vegvesen: ',
  'Taken out of the car for the rental': 'Tatt ut av bilen for utleien', 'Put into the car for the rental': 'Lagt i bilen for utleien',
  'Roof box': 'Takboks', 'Ski rack': 'Skistativ',
  'Rental cars not returned on time': 'Leiebiler som ikke er levert i tide', 'Rental cars – EU-kontroll due': 'Leiebiler – EU-kontroll',
  'Give the date the car is expected back': 'Oppgi datoen bilen ventes tilbake',
  'Rental returned · customer details moved to the trash': 'Leiebil levert · kundeopplysninger flyttet til papirkurven',
  'e.g. winter wheels in the boot': 'f.eks. vinterhjul i bagasjerommet',
  'Statens vegvesen is not set up (System page), so EU-kontroll must be typed in by hand.':
    'Statens vegvesen er ikke satt opp (System-siden), så EU-kontroll må skrives inn for hånd.',
  'Filled in from Statens vegvesen, and updated automatically when the car has passed.':
    'Fylles inn fra Statens vegvesen, og oppdateres automatisk når bilen har bestått.',
  'Statens vegvesen is not set up, so type the date from the registration certificate.':
    'Statens vegvesen er ikke satt opp, så skriv inn datoen fra vognkortet.',
  'The EU-kontroll deadline has passed – the car should not be driven.': 'EU-kontrollfristen er passert – bilen bør ikke kjøres.',
  'The EU-kontroll deadline is before the expected return:': 'EU-kontrollfristen er før bilen ventes tilbake:',
  'Rental car': 'Leiebil', 'Rental': 'Utleie', 'Registration number at Statens vegvesen': 'Registreringsnummeret hos Statens vegvesen',
  'This car is out on rental; register the return first': 'Denne bilen er utleid; registrer innleveringen først',
  'This car is already out on rental': 'Denne bilen er allerede utleid',
  'This car was just rented out by someone else; reload and try again': 'Denne bilen ble nettopp leid ut av noen andre; last inn på nytt og prøv igjen',
  'This rental is already returned': 'Denne utleien er allerede levert', 'Registration number is not valid': 'Registreringsnummeret er ikke gyldig',
  'Registration number is required': 'Registreringsnummer må fylles inn', 'Expected return: not a valid date and time': 'Ventes tilbake: ikke en gyldig dato og tid',
  'Statens vegvesen is not set up (API key on the System page)': 'Statens vegvesen er ikke satt opp (API-nøkkel på System-siden)',
  'Not found at Statens vegvesen': 'Ikke funnet hos Statens vegvesen',
};

// Texts with numbers, names or dates in them. {} = any text, {n} = a number.
// In the Norwegian text {1}, {2}… insert the parts; {1t} also translates that part.
const NO_PATTERNS = [
  ['{} not found', '{1t} ble ikke funnet'],
  ['Known damage ({n})', 'Kjente skader ({1})'], ['Repaired damage ({n})', 'Reparerte skader ({1})'],
  ['Check data: Statens vegvesen differs ({n})', 'Sjekk data: Statens vegvesen avviker ({1})'],
  ['In progress ({n})', 'Pågår ({1})'], ['Out on test drive now ({n})', 'Ute på prøvekjøring nå ({1})'],
  ['Out on rental now ({n})', 'Utleid nå ({1})'], ['Rental cars ({n})', 'Leiebiler ({1})'], ['{} is rented out', '{1} er leid ut'],
  ['Statens vegvesen checked {}', 'Statens vegvesen sjekket {1}'], ['last approved {}', 'sist godkjent {1}'], ['expected back {}', 'ventet tilbake {1}'],
  ['{} is already a rental car', '{1} er allerede en leiebil'], ['Remove {} from the rental cars?', 'Fjerne {1} fra leiebilene?'],
  ['The EU-kontroll deadline for {} has passed.\n\nRent it out anyway?', 'EU-kontrollfristen for {1} er passert.\n\nLeie den ut likevel?'],
  ['Returned — customer details in the trash ({n})', 'Levert tilbake — kundeopplysninger i papirkurven ({1})'],
  ['All checks ({n})', 'Alle kontroller ({1})'], ['Storage spots ({n} active)', 'Lagerplasser ({1} aktive)'],
  ['{n} car', '{1} bil'], ['{n} cars', '{1} biler'], ['{n} car →', '{1} bil →'], ['{n} cars →', '{1} biler →'],
  ['{n} / {n} cars', '{1} / {2} biler'], ['{n} total', '{1} totalt'], ['{n} sub-zones', '{1} undersoner'], ['{n} to place', '{1} skal plasseres'],
  ['{n} cars in {n} spots', '{1} biler på {2} plasser'], ['{n} car in {n} spot', '{1} bil på {2} plass'], ['{n} cars in {n} spot', '{1} biler på {2} plass'],
  ['{n} car in {n} spots', '{1} bil på {2} plasser'], ['· {n} off site', '· {1} utenfor lageret'],
  ['{} ({n} cars)', '{1} ({2} biler)'], ['{} ({n} car)', '{1} ({2} bil)'], ['{} ({n}/{n} cars)', '{1} ({2}/{3} biler)'], ['{} ({n}/{n} car)', '{1} ({2}/{3} bil)'],
  ['{n} day', '{1} dag'], ['{n} days', '{1} dager'], ['in {n} d', 'om {1} d'], ['{n} d overdue', '{1} d forsinket'], ['overdue by {n} d', 'forsinket med {1} d'],
  ['Due in {n} days', 'Frist om {1} dager'], ['Due in {n} day', 'Frist om {1} dag'], ['Overdue by {n} days', 'Forsinket med {1} dager'], ['Overdue by {n} day', 'Forsinket med {1} dag'],
  ['Service due in {n} days', 'Service om {1} dager'], ['Service due in {n} day', 'Service om {1} dag'], ['Service due ({n} days ago)', 'Service forfalt ({1} dager siden)'],
  ['Service due ({n} day ago)', 'Service forfalt ({1} dag siden)'], ['Service overdue by {n} days', 'Service forsinket med {1} dager'], ['Service overdue by {n} day', 'Service forsinket med {1} dag'],
  ['EU-kontroll: Due in {n} days', 'EU-kontroll: frist om {1} dager'], ['EU-kontroll: Overdue by {n} days', 'EU-kontroll: forsinket med {1} dager'],
  ['EU-kontroll: Overdue by {n} day', 'EU-kontroll: forsinket med {1} dag'], ['EU-kontroll: Due today', 'EU-kontroll: frist i dag'], ['EU-kontroll: Due tomorrow', 'EU-kontroll: frist i morgen'],
  ['EU-kontroll {}', 'EU-kontroll {1}'], ['EU-kontroll due {}', 'EU-kontroll frist {1}'], ['due {}', 'frist {1}'], ['due {} (in {n} d)', 'frist {1} (om {2} d)'],
  ['last {} at {}', 'sist {1} ved {2}'], ['last {}', 'sist {1}'], ['Previous service: {} at {}.', 'Forrige service: {1} ved {2}.'], ['Previous service: {}.', 'Forrige service: {1}.'],
  ['{} min', '{1} min'], ['{n} h {n} min', '{1} t {2} min'], ['{n} d {n} h', '{1} d {2} t'],
  ['Spot {}', 'Plass {1}'], ['spot {}', 'plass {1}'], ['{} since {}', '{1} siden {2}'], ['since {}', 'siden {1}'], ['In spot since {}', 'På plassen siden {1}'],
  ['Out since {} ({})', 'Ute siden {1} ({2})'], ['Started {}', 'Startet {1}'], ['started {}', 'startet {1}'], ['Stored {}', 'Lagret {1}'],
  ['{n}/4 photos', '{1}/4 bilder'], ['{n} damage', '{1} skade'], ['{n} damages', '{1} skader'], ['{n} damage(s)', '{1} skade(r)'], ['{}, {n} damage(s)', '{1}, {2} skade(r)'],
  ['Arrival inspection · {} · started {}', 'Mottakskontroll · {1} · startet {2}'], ['Arrival inspection · no inspector · started {}', 'Mottakskontroll · ingen kontrollør · startet {1}'],
  ['Arrival inspection ', 'Mottakskontroll '], ['Completed {}. Odometer {}.', 'Fullført {1}. Kilometerstand {2}.'], ['This inspection was cancelled {}.', 'Denne kontrollen ble avbrutt {1}.'],
  ['Stored at {}', 'Lagret på {1}'], ['{}: no photo', '{1t}: ingen bilde'], ['✓ {}', '✓ {1t}'], ['📷 {}', '📷 {1t}'], ['{} (missing: {})', '{1t} (mangler: {2t})'],
  ['{} is already in stock ({}). ', '{1} er allerede på lager ({2t}). '], ['{} already has an arrival inspection in progress. Continuing will open it.', '{1} har allerede en pågående mottakskontroll. Fortsett for å åpne den.'],
  ['Known vehicle: {}. A new arrival inspection will be added to its history.', 'Kjent bil: {1}. En ny mottakskontroll legges til i historikken.'],
  ['{n}/17 characters', '{1}/17 tegn'], ['From the VIN: {}.', 'Fra VIN: {1}.'], ['model year {n}', 'årsmodell {1}'], ['{} confidence', '{1t} sikkerhet'],
  ['high', 'høy'], ['medium', 'middels'], ['low', 'lav'], ['Plate · {} confidence · tap to look up', 'Skilt · {1t} sikkerhet · trykk for å slå opp'],
  ['1 character corrected (read as {})', '1 tegn rettet (lest som {1})'], ['VINs never contain {} — did you mean 1 or 0?', 'VIN inneholder aldri {1} — mente du 1 eller 0?'],
  ['Could not reach Statens vegvesen: {}', 'Fikk ikke kontakt med Statens vegvesen: {1t}'], ['Registration status: {}. ', 'Registreringsstatus: {1}. '],
  ['EU-kontroll {}. ', 'EU-kontroll {1t}. '], ['due in {n} days', 'frist om {1} dager'], ['overdue by {n} days', 'forsinket med {1} dager'],
  ['— only character {n} differs.', '— bare tegn {1} er forskjellig.'], ['Reg. no {} is already on ', 'Reg.nr. {1} er allerede på '], ['Reg. no {}', 'Reg.nr. {1}'],
  ['— {}, {}', '— {1t}, {2t}'], ['{} — {}, {}', '{1t} — {2t}, {3t}'], ['{} · {}', '{1t} · {2t}'], ['{} · {} · {}', '{1t} · {2t} · {3t}'],
  ['Found {}', 'Funnet {1}'], ['Repaired {} — {}', 'Reparert {1} — {2}'], ['Repaired {}', 'Reparert {1}'],
  ['Deleted {} by {}', 'Slettet {1} av {2}'], ['Deleted {}', 'Slettet {1}'], ['Deleted automatically {} (no activity for the retention period)', 'Slettet automatisk {1} (ingen aktivitet i lagringsperioden)'],
  ['· removed for good {}', '· slettes for godt {1}'], ['Restored to {}', 'Gjenopprettet til {1}'], ['{} moved to Recently deleted', '{1} flyttet til Nylig slettet'],
  ['Last fetched {} · {n} distinct version(s) stored', 'Sist hentet {1} · {2} ulike versjoner lagret'], ['· last {}', '· sist {1}'],
  ['Marked as registered. {}', 'Merket som registrert. {1t}'], ['Confirm that {} ({}) has been registered in Norway.', 'Bekreft at {1} ({2}) er registrert i Norge.'],
  ['The deadline is {}. Book EU-kontroll now.', 'Fristen er {1}. Bestill EU-kontroll nå.'],
  ['The deadline was {}. The car must pass EU-kontroll before it is driven on public roads.', 'Fristen var {1}. Bilen må godkjennes på EU-kontroll før den kjøres på offentlig vei.'],
  ['Registered ({})', 'Registrert ({1})'], ['{}: {} → {}', '{1t}: {2} → {3}'], ['{} → {}', '{1} → {2}'], ['From {}', 'Fra {1}'], ['To {}', 'Til {1}'],
  ['VIN via {}', 'VIN via {1t}'], ['manual', 'manuelt'], ['photo', 'bilde'], ['registry', 'registeret'], ['barcode', 'strekkode'],
  ['Used Statens vegvesen: {}', 'Brukte Statens vegvesen: {1}'], ['Kept ours: {}', 'Beholdt vår: {1}'], ['{} driven', '{1} kjørt'],
  ['Taken out: {}', 'Tatt ut: {1}'], ['Put in: {}', 'Lagt i: {1}'], ['Not OK: {n}', 'Ikke OK: {1}'], ['12V {} V', '12V {1} V'], ['battery charged', 'batteri ladet'], ['battery replaced', 'batteri byttet'],
  ['To {} · from e-mail app · sent again', 'Til {1} · fra e-postprogram · sendt på nytt'], ['To {} · from e-mail app', 'Til {1} · fra e-postprogram'], ['To {} · sent again', 'Til {1} · sendt på nytt'],
  ['from {}', 'fra {1}'], ['Delete this car?\n\n{}\n\nIt moves to "Recently deleted" and can be restored from there. {}', 'Slette denne bilen?\n\n{1}\n\nDen flyttes til «Nylig slettet» og kan gjenopprettes derfra. {2t}'],
  ['It is removed for good after {n} days.', 'Den slettes for godt etter {1} dager.'],
  ['Delete {} ({}) permanently?\n\nAll its data and photos are removed now. This cannot be undone.', 'Slette {1} ({2}) permanent?\n\nAlle data og bilder fjernes nå. Dette kan ikke angres.'],
  // today
  ['sent {} to {} · enter the date when they reply', 'sendt {1} til {2} · legg inn datoen når de svarer'], ['started {} by {}', 'startet {1} av {2}'],
  ['{} ({})', '{1} ({2t})'], ['was {}', 'var {1}'], ['{} · today', '{1t} · i dag'], ['{} · {n} d overdue', '{1t} · {2} d forsinket'], ['{} · in {n} d', '{1t} · om {2} d'],
  // test drive
  ['{} is out on a test drive', '{1} er ute på prøvekjøring'], ['Put back in the car: {}', 'Legg tilbake i bilen: {1}'], ['Taken out of the car: {}', 'Tatt ut av bilen: {1}'],
  ['Customer details and the licence photo are moved to the trash when the car is returned, and deleted for good after {n} days.', 'Kundeopplysninger og førerkortbilde flyttes til papirkurven når bilen leveres tilbake, og slettes for godt etter {1} dager.'],
  ['Kept for {n} days after the return (e.g. for toll or speeding fines), then deleted for good.', 'Beholdes i {1} dager etter innlevering (f.eks. for bompenger eller fartsbøter), deretter slettes de for godt.'],
  ['{} → {} · {} driven · deleted for good {}', '{1} → {2} · {3} kjørt · slettes for godt {4}'], ['{} → {} · deleted for good {}', '{1} → {2} · slettes for godt {3}'],
  ['Note: {}', 'Merknad: {1}'], ['Driving licence — {}', 'Førerkort — {1}'], ['Access log — {}', 'Tilgangslogg — {1}'], ['Access log — test drive', 'Tilgangslogg — prøvekjøring'],
  ['Opened licence photo — {}', 'Åpnet førerkortbilde — {1}'], ['Deleted customer details — {}', 'Slettet kundeopplysninger — {1}'],
  ["Delete {}'s details and licence photo for good now? This cannot be undone.", 'Slette opplysningene og førerkortbildet til {1} for godt nå? Dette kan ikke angres.'],
  [' since {} — {}, ', ' siden {1} — {2}, '],
  // trade plates
  ['Trade plates: {}', 'Prøvekjennemerker: {1}'], ['Trade plates taken off: {}', 'Prøvekjennemerker tatt av: {1}'],
  ['{} – on {}', '{1} – på {2}'], ['– on {} (test drive)', '– på {1} (prøvekjøring)'], ['New name for {}', 'Nytt navn for {1}'],
  ['{} moved to {}', '{1} flyttet til {2}'],
  ['{} moved to {} — register the return of this car.', '{1} flyttet til {2} — registrer innlevering av denne bilen.'],
  ["{} moved to {} on {}. This car can't be driven without them — register its return.",
    '{1} flyttet til {2} {3}. Denne bilen kan ikke kjøres uten dem — registrer innleveringen.'],
  ['Trade plates {} moved to another car {} — register the return.', 'Prøvekjennemerker {1} flyttet til en annen bil {2} — registrer innlevering.'],
  ['On {} (out on test drive since {}). They will be moved to this car, and you register the return of {} next.',
    'På {1} (ute på prøvekjøring siden {2}). De flyttes til denne bilen, og deretter registrerer du innlevering av {3}.'],
  ['{} are on {}, which is out on a test drive.\n\nMove them to {}? You then register the return of {}.',
    '{1} står på {2}, som er ute på prøvekjøring.\n\nFlytte dem til {3}? Deretter registrerer du innlevering av {4}.'],
  ['{} are on {}; move them to this car?', '{1} står på {2}; flytte dem til denne bilen?'],
  // Statens vegvesen sync
  ['Last checked {}: found in the vehicle registry', 'Sist sjekket {1}: funnet i kjøretøyregisteret'],
  ['Last checked {}: not in the vehicle registry yet', 'Sist sjekket {1}: ikke i kjøretøyregisteret ennå'],
  // PDI
  ['Sent {} to {} by {} (e-mail app)', 'Sendt {1} til {2} av {3} (e-postprogram)'], ['Sent {} to {} by {}', 'Sendt {1} til {2} av {3}'], ['Sent {} to {} (e-mail app)', 'Sendt {1} til {2} (e-postprogram)'],
  ['Sent {} to {}', 'Sendt {1} til {2}'], ['Sent to {}', 'Sendt til {1}'], ['PDI done {} ({})', 'Nybilklargjøring utført {1} ({2})'], ['PDI done {}', 'Nybilklargjøring utført {1}'],
  ['PDI booked {}', 'Nybilklargjøring booket {1}'],
  ['Missing: {}', 'Mangler: {1t}'], ['Edit {}', 'Endre {1}'],
  ['Delete {}?\n\nThey are removed from the staff list and their phone number and PIN are deleted. Their name stays on the history they are part of (inspections, storage checks…). This cannot be undone.',
    'Slette {1}?\n\nVedkommende fjernes fra listen over ansatte, og telefonnummer og PIN-kode slettes. Navnet blir stående i historikken vedkommende er en del av (kontroller, lagerkontroller…). Dette kan ikke angres.'],
  ['PDI today at {}', 'Nybilklargjøring i dag kl. {1}'], ['PDI tomorrow at {}', 'Nybilklargjøring i morgen kl. {1}'], ['PDI {} at {}', 'Nybilklargjøring {1} kl. {2}'],
  ['✓ Prepared for the PDI {} by {}', '✓ Klargjort til nybilklargjøring {1} av {2}'], ['✓ Prepared for the PDI {}', '✓ Klargjort til nybilklargjøring {1}'],
  ['Winter wheels: {}', 'Vinterhjul: {1}'], ['Moved to {}', 'Flyttet til {1}'], ['· PDI {}', '· nybilklargjøring {1}'],
  ['{} – on {} (test drive)', '{1} – på {2} (prøvekjøring)'], ['{} are on {} (out on a test drive) right now.', '{1} står på {2} (ute på prøvekjøring) nå.'],
  ['Printed / PDF {} by {}', 'Skrevet ut / PDF {1} av {2}'], ['Printed / PDF {}', 'Skrevet ut / PDF {1}'], ['printed / PDF {}', 'skrevet ut / PDF {1}'],
  ['printed / PDF {} · enter the date when they reply', 'skrevet ut / PDF {1} · legg inn datoen når de svarer'], ['sent {} to {}', 'sendt {1} til {2}'], ['done {} by {}', 'utført {1} av {2}'], ['done {}', 'utført {1}'],
  ['{} · expected {}', '{1} · forventet {2}'], ['{} · {} · expected {}', '{1} · {2} · forventet {3}'], ['expected {}', 'forventet {1}'],
  ['Photos from the arrival inspection ({n})', 'Bilder fra mottakskontrollen ({1})'], ['Taken {}', 'Tatt {1}'],
  ['Documents ({n})', 'Dokumenter ({1})'], ['Added {} by {}', 'Lagt til {1} av {2}'], ['Added {}', 'Lagt til {1}'],
  ['Changed {} by {}', 'Endret {1} av {2}'], ['Changed {}', 'Endret {1}'], ['File: {}', 'Fil: {1}'],
  ['Delete "{}"? This can\'t be undone.', 'Slette «{1}»? Dette kan ikke angres.'],
  // used cars: 12V charging every month
  ['last charged {}', 'sist ladet {1}'], ['Last charged {}', 'Sist ladet {1t}'], ['{} · tomorrow', '{1t} · i morgen'],
  ['Not charged since it came into storage {}', 'Ikke ladet siden den kom på lager {1}'], ['All charges ({n})', 'Alle ladinger ({1})'],
  ['before {} V', 'før {1} V'], ['after {} V', 'etter {1} V'],
  ['Cancel the 12V charge from {}?\n\nIt stops counting but stays in the list, struck through.\nReason (required):',
    'Annullere 12V-ladingen fra {1}?\n\nDen teller ikke lenger, men blir stående i listen, gjennomstreket.\nBegrunnelse (påkrevd):'],
  ['Below {} V after charging – the battery may need replacing. Write what was done under Note.',
    'Under {1} V etter lading – batteriet må kanskje byttes. Skriv hva som ble gjort under Merknad.'],
  ['Below {} V after charging – write what was done under Note', 'Under {1} V etter lading – skriv hva som ble gjort under Merknad'],
  // storage maintenance
  ['Do {}', 'Utfør {1t}'], ['monthly check', 'månedlig sjekk'], ['3-month check', '3-månederssjekk'], ['6-month check', '6-månederssjekk'],
  ['{} — {}', '{1t} — {2t}'], ['{} saved', '{1t} lagret'], ['Last check {} by {}', 'Siste kontroll {1} av {2}'], ['Last check {}', 'Siste kontroll {1}'],
  ['· 12V {} V', '· 12V {1} V'], ['· SOC {n} %', '· SOC {1} %'], ['In storage since {} · {n} checks recorded', 'På lager siden {1} · {2} kontroller registrert'],
  ['In storage since {} · {n} check recorded', 'På lager siden {1} · {2} kontroll registrert'], ['— {}, {}', '— {1}, {2}'],
  ['Cancelled {} by {}: {}', 'Annullert {1} av {2}: {3}'], ['Cancelled {}: {}', 'Annullert {1}: {2}'],
  ['Cancel the {} from {}?\n\nIt stops counting in the schedule but stays in the report, struck through.\nReason (required):',
    'Annullere {1t} fra {2}?\n\nDen teller ikke lenger i planen, men blir stående i rapporten, gjennomstreket.\nBegrunnelse (påkrevd):'],
  ['first storage check', 'første lagerkontroll'], ['✓ Done {} by {}', '✓ Utført {1} av {2}'], ['✓ Done {}', '✓ Utført {1}'],
  ['Answer every point (missing: {})', 'Svar på alle punkter (mangler: {1t})'], ['Tyre pressure {} bar – adjust to 2,7 ± 0,1 bar.', 'Dekktrykk {1} bar – juster til 2,7 ± 0,1 bar.'],
  ['12V is below {} V – charge or replace the battery.', '12V er under {1} V – lad eller bytt batteriet.'], ['SOC below {n} % – charge to at least {n} %.', 'SOC under {1} % – lad til minst {2} %.'],
  ['For storage over a month MG wants SOC over {n} %.', 'For lagring over en måned krever MG SOC over {1} %.'], ['Charged to (min. {n} %)', 'Ladet til (min. {1} %)'],
  ['All four tyres within {}–{} bar (adjusted if needed)', 'Alle fire dekk innenfor {1}–{2} bar (justert ved behov)'], ['{} · {}', '{1t} · {2t}'],
  ['← {}', '← {1}'],
  // settings
  ['Last login {}', 'Siste innlogging {1}'], ['New PIN for {}. Tell them the PIN in person; they can change it themselves afterwards (their name at the top → Change PIN).',
    'Ny PIN-kode for {1}. Gi beskjed om PIN-koden personlig; de kan endre den selv etterpå (navnet sitt øverst → Endre PIN-kode).'],
  ['PIN saved for {}', 'PIN-kode lagret for {1}'], ['Make {} system admin? They can change all system settings (API key, e-mail server…).', 'Gjøre {1} til systemadministrator? Vedkommende kan endre alle systeminnstillinger (API-nøkkel, e-postserver…).'],
  ['Capacity for {}', 'Kapasitet for {1}'], ['Description for {}', 'Beskrivelse for {1}'], ['Description saved for {}', 'Beskrivelse lagret for {1}'],
  ['Currently at {}.', 'Står nå på {1}.'], ['{}: max {n} cars', '{1}: maks {2} biler'], ['{}: no limit', '{1}: ingen grense'], ['Added {n} spots', 'La til {1} plasser'],
  ['Added {}', 'La til {1}'], ['Sub-zone in {}', 'Undersone i {1}'], ['Deactivate {} and all its sub-zones?', 'Deaktivere {1} og alle undersonene?'],
  ['New code for {}', 'Ny kode for {1}'], ['{} renamed to {}', '{1} har fått nytt navn: {2}'], ['{} deleted', '{1} slettet'], ['Delete {}', 'Slett {1}'], ['Delete {}?', 'Slette {1}?'],
  ['{} and its {n} sub-zone', '{1} og {2} undersone'], ['{} and its {n} sub-zones', '{1} og {2} undersoner'],
  ['{} has {n} car. Move it to:', '{1} har {2} bil. Flytt den til:'], ['{} has {n} cars. Move all of them to:', '{1} har {2} biler. Flytt alle til:'],
  ['Move {n} car and delete', 'Flytt {1} bil og slett'], ['Move {n} cars and delete', 'Flytt {1} biler og slett'],
  ['No spot has room for {n} cars. Add a spot or raise a capacity first, or move the cars one by one.', 'Ingen plass har rom for {1} biler. Legg til en plass eller øk kapasiteten først, eller flytt bilene én og én.'],
  ['{n} car moved to {}; {} deleted', '{1} bil flyttet til {2}; {3} slettet'], ['{n} cars moved to {}; {} deleted', '{1} biler flyttet til {2}; {3} slettet'],
  ['The {n} car already in {} stay there ', 'Den {1} bilen som allerede står på {2}, blir stående '], ['The {n} cars already in {} stay there ', 'De {1} bilene som allerede står på {2}, blir stående '],
  ['as "not in a sub-zone" until moved into one. New cars must go into a sub-zone.', 'som «ikke i en undersone» til de flyttes inn i en. Nye biler må plasseres i en undersone.'],
  ['Name', 'Navn'], ['E-mail address', 'E-postadresse'], ['Choices, separated by commas (empty = none)', 'Valg, skilt med komma (tom = ingen)'],
  ['API key configured (ending in …{}). ', 'API-nøkkel satt (slutter på …{1}). '], ['API key configured. ', 'API-nøkkel satt. '],
  ['Registered vehicles are re-synced every {n} days.', 'Registrerte biler synkroniseres hver {1}. dag.'], ['Latest error ({}): {}', 'Siste feil ({1}): {2}'],
  [' for {n} days and can be restored. After that they are removed for good, with all photos.', ' i {1} dager og kan gjenopprettes. Deretter slettes de for godt, med alle bilder.'],
  ['Cars that are off site (sold/delivered) and have had no activity for {n} years are deleted automatically — they go to Recently deleted first. Cars in storage are never deleted automatically.',
    'Biler som ikke er på lager (solgt/levert) og har vært uten aktivitet i {1} år slettes automatisk — de havner først i Nylig slettet. Biler på lager slettes aldri automatisk.'],
  ['In Recently deleted now: {n}', 'I Nylig slettet nå: {1}'], ['In Recently deleted now: {n} · Due for automatic deletion within 30 days: {n}', 'I Nylig slettet nå: {1} · Slettes automatisk innen 30 dager: {2}'],
  [' → Statens vegvesen → API key.', ' → Statens vegvesen → API-nøkkel.'], [' page → Data retention.', '-siden → Lagring av data.'],
  // system
  ['Set ({}) – type a new value to replace', 'Satt ({1}) – skriv en ny verdi for å bytte'], ['Default: {}', 'Standard: {1}'], ['{} saved', '{1t} lagret'],
  ['Reset “{}” to the server environment / default?', 'Tilbakestille «{1t}» til servermiljøet / standard?'], [' · {} by {}', ' · {1} av {2}'], [' · {}', ' · {1}'],
  // server messages with values
  ['{} already exists', '{1} finnes allerede'], ['{} is full ({n} of {n} cars)', '{1} er full ({2} av {3} biler)'], ['{} is inactive', '{1} er inaktiv'],
  ['{} is split into sub-zones; choose one of them', '{1} er delt i undersoner; velg en av dem'], ['{} has {n} car; choose a spot to move them to', '{1} har {2} bil; velg en plass å flytte den til'],
  ['{} has {n} cars; choose a spot to move them to', '{1} har {2} biler; velg en plass å flytte dem til'], ['The car is already at {}', 'Bilen står allerede på {1}'],
  ['There is 1 car here; move them before deactivating', 'Det står 1 bil her; flytt den før du deaktiverer'], ['There are {n} cars here; move them before deactivating', 'Det står {1} biler her; flytt dem før du deaktiverer'],
  ["There are already {n} cars here; capacity can't be lower than that", 'Det står allerede {1} biler her; kapasiteten kan ikke være lavere enn det'],
  ['The PIN must be {n}–{n} digits', 'PIN-koden må være {1}–{2} sifre'], ['Too many wrong PINs. Try again in {n} min, or ask an administrator.', 'For mange feil PIN-koder. Prøv igjen om {1} min, eller spør en administrator.'],
  ['Wrong PIN ({n} tries left)', 'Feil PIN-kode ({1} forsøk igjen)'], ['Wrong PIN. Locked for {n} min.', 'Feil PIN-kode. Låst i {1} min.'],
  ['Inspection is not complete yet: {}', 'Kontrollen er ikke fullført ennå: {1t}'], ['Inspection is {} and can no longer be changed', 'Kontrollen er {1t} og kan ikke lenger endres'],
  ['completed', 'fullført'], ['cancelled', 'avbrutt'], ['in progress', 'pågår'],
  ['Odometer in ({n}) is lower than when the car left ({n})', 'Kilometerstand inn ({1}) er lavere enn da bilen dro ({2})'],
  ["12V below {} V or not 'Good': record whether the battery was charged or replaced", "12V under {1} V eller ikke 'God': registrer om batteriet ble ladet eller byttet"],
  ['SOC below {n} %: charge to at least {n} % and enter the new value', 'SOC under {1} %: lad til minst {2} % og legg inn ny verdi'],
  ['API key rejected by Statens vegvesen (HTTP {n})', 'API-nøkkelen ble avvist av Statens vegvesen (HTTP {1})'], ['Network error: {}', 'Nettverksfeil: {1}'],
  ['Could not send the e-mail: {}', 'Kunne ikke sende e-posten: {1}'], ['Spot {} deleted', 'Plass {1} slettet'],
  ['{}: give at most {n} items', '{1t}: oppgi maks {2} punkter'], ['{}: not a valid list', '{1t}: ikke en gyldig liste'], ['Removed items', 'Uttatt utstyr'], ['Added items', 'Tillagt utstyr'],
  ['Carbonara v{} · built {}', 'Carbonara v{1} · bygget {2}'], ['Error {n}', 'Feil {1}'], ['Not before {}', 'Ikke før {1}'], ['Not after {}', 'Ikke etter {1}'],
  // customer car delivery (kiosk)
  ['We use your name and phone number only to contact you about the car. The registration is deleted {n} days after we have received the car.',
    'Vi bruker navnet og telefonnummeret ditt bare til å kontakte deg om bilen. Registreringen slettes {1} dager etter at vi har tatt imot bilen.'],
  ['Waiting to be received ({n})', 'Venter på mottak ({1})'], ['Received ({n})', 'Mottatt ({1})'],
  ["Received deliveries are deleted automatically {n} days after they were received, with the customer's details.",
    'Mottatte leveringer slettes automatisk {1} dager etter at de ble mottatt, med kundens opplysninger.'],
  ['Delivered {}', 'Levert {1}'], ['delivered {}', 'levert {1}'], ['Received {}', 'Mottatt {1}'], ['by {}', 'av {1}'],
  ['deleted automatically {}', 'slettes automatisk {1}'], ['{} received', '{1} mottatt'], ['Used by {n} deliveries', 'Brukt av {1} leveringer'],
  ["Have you got the car and the key for {}?\n\nThe delivery, with the customer's name and phone number, is deleted automatically {n} days from now.",
    'Har du fått bilen og nøkkelen til {1}?\n\nLeveringen, med kundens navn og telefonnummer, slettes automatisk om {2} dager.'],
  ["Delete the delivery of {} now, with the customer's details?", 'Slette leveringen av {1} nå, med kundens opplysninger?'],
  // teams (System page)
  ['There is already a team called {}', 'Det finnes allerede et team som heter {1}'], ['Unknown menu item: {}', 'Ukjent menypunkt: {1}'],
  ['Members ({n})', 'Medlemmer ({1})'], ['{} (now in {})', '{1} (nå i {2})'], ['Without a team (only Today): {}', 'Uten team (bare I dag): {1}'],
  ['Delete the team {}? Its {n} member(s) will only see Today until you place them in another team.',
    'Slette teamet {1}? Medlemmene ({2}) ser bare I dag til du plasserer dem i et annet team.'],
  ['Delete the team {}?', 'Slette teamet {1}?'],
  ['Stop {} from showing the delivery form?', 'Stoppe {1} fra å vise leveringsskjemaet?'], ['Set up {}', 'Satt opp {1}'], ['last used {}', 'sist brukt {1}'],
];

// Norwegian texts Carbonara itself uses (outside documents) -> English.
const EN = {
  // storage checklist (labels are Norwegian because they are printed on the report)
  'Minimum 150 mm til neste objekt foran og bak': 'At least 150 mm to the next object in front and behind',
  'Minimum 600 mm åpen plass på siden': 'At least 600 mm of open space at the side',
  'Ikke parkert under trær eller annet som kan skade bilen': 'Not parked under trees or anything else that can damage the car',
  'Lagret vekk fra varmekilder og svært fuktige områder': 'Stored away from heat sources and very humid areas',
  'Girspak i P (automat) / 1. gir (manuell), parkeringsbrems ikke på': 'Gear lever in P (automatic) / 1st gear (manual), parking brake not applied',
  'Ingenting på dashbordet, solskjerm i hvileposisjon': 'Nothing on the dashboard, sun visor in rest position',
  'Alle A/C-ventiler åpne': 'All A/C vents open',
  'Takluke og gardin, vinduer, dører, panser og bakluke lukket': 'Sunroof and sunshade, windows, doors, bonnet and tailgate closed',
  'Teppebeskyttelse lagt inn på førersiden': 'Carpet cover fitted on the driver side',
  'Viskerarmer løftet': 'Wiper arms lifted',
  'Alt elektrisk utstyr avslått': 'All electrical equipment switched off',
  '12V-batteri frakoblet (minuspol)': '12V battery disconnected (negative terminal)',
  'Sjekk lakk for aggressive stoffer (mose, kvae, støv, fugleskitt), vask ved behov': 'Check paint for aggressive substances (moss, tree sap, dust, bird droppings); wash if needed',
  'Åpne og lukk dører, panser og bakluke; test horn 3 ganger': 'Open and close doors, bonnet and tailgate; test the horn 3 times',
  'Start bilen på tomgang i minst 5 minutter, lytt etter lyder': 'Run the engine at idle for at least 5 minutes, listen for noises',
  'Skru på A/C og bruk ventilasjonen én gang (over 5 °C)': 'Turn on the A/C and use the vents once (above 5 °C)',
  'Flytt bilen minimum 40 cm': 'Move the car at least 40 cm',
  'Koble fra 12V-batteri': 'Disconnect the 12V battery',
  'READY-modus i 10 min, deretter 12V tilkoblet i 2 timer (balansering av HV-batteri)': 'READY mode for 10 min, then 12V connected for 2 hours (HV battery balancing)',
  'Rengjør viskere og ruter, test spylere': 'Clean wipers and windows, test the washers',
  'Sjekk og etterfyll væsker: kjølevæske, motorolje, spylervæske, bremsevæske': 'Check and top up fluids: coolant, engine oil, washer fluid, brake fluid',
  'Sjekk alle dørpakninger og taklukepakning': 'Check all door seals and the sunroof seal',
  'Sjekk lakk, interiør og overflater': 'Check paint, interior and surfaces',
  'Lad HV-batteriet i minimum 2 timer med AC-lading': 'Charge the HV battery for at least 2 hours with AC charging',
  // battery tester results / actions
  'God': 'Good', 'God – lad opp': 'Good – recharge', 'Lad og test på nytt': 'Charge and retest', 'Bytt batteri': 'Replace battery',
  'Ingen': 'None', 'Ladet': 'Charged', 'Byttet': 'Replaced',
  // winter tyre options
  'Ingen vinterdekk': 'No winter tyres', 'Vinterdekk på lager': 'Winter tyres in stock',
  'Vinterdekk bestilt av selger': 'Winter tyres ordered by sales', 'Vinterdekk bestilles av verkstedet': 'Winter tyres ordered by the workshop',
  // date/time placeholders written in Norwegian
  'dd.mm.åååå': 'dd.mm.yyyy', 'tt:mm': 'hh:mm',
};

// ---------------------------------------------------------------- engine

// Texts are matched without their leading/trailing spaces (those are kept as they are).
const trimmed = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k.trim(), v.trim()]));
const NO_T = trimmed(NO);
const EN_T = trimmed(EN);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Most specific first: the pattern with the most fixed text wins, so
// "started {} by {}" is tried before "started {}".
const COMPILED = NO_PATTERNS.map(([from, to]) => {
  const parts = from.trim().split(/(\{\}|\{n\})/);
  const re = parts.map((p) => (p === '{}' ? '([\\s\\S]+?)' : p === '{n}' ? '(-?\\d+(?:[.,]\\d+)?)' : escapeRe(p))).join('');
  const fixed = parts.filter((p) => p !== '{}' && p !== '{n}').join('').length;
  return [new RegExp(`^${re}$`), to.trim(), fixed];
}).sort((a, b) => b[2] - a[2]);

// Icons/arrows before or after a text ("📝 PDI orders…", "Manage spots →").
const EDGES = /^([^\p{L}\p{N}"'«(]+)?([\s\S]*?)([\s→↗…:]+)?$/u;

function lookup(core) {
  if (lang === 'no') {
    if (Object.prototype.hasOwnProperty.call(NO_T, core)) return NO_T[core];
    for (const [re, to] of COMPILED) {
      const m = core.match(re);
      if (m) return to.replace(/\{(\d+)(t?)\}/g, (_, i, t) => (t ? translateCore(m[i]) : m[i]));
    }
    return null;
  }
  return Object.prototype.hasOwnProperty.call(EN_T, core) ? EN_T[core] : null;
}

function translateCore(core) {
  if (!/[A-Za-zÆØÅæøå]{2}/.test(core)) return core; // numbers, dates, symbols
  const direct = lookup(core);
  if (direct != null) return direct;
  // Try again without leading icons / trailing arrows, and put them back.
  const m = core.match(EDGES);
  if (m && (m[1] || m[3]) && m[2]) {
    const inner = lookup(m[2]);
    if (inner != null) return (m[1] || '') + inner + (m[3] || '');
  }
  return core;
}

/** Translate one text (keeps leading/trailing spaces). */
export function tr(text) {
  if (text == null) return text;
  const s = String(text);
  const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
  if (!m[2]) return s;
  const out = translateCore(m[2]);
  return out === m[2] ? s : m[1] + out + m[3];
}

const SKIP = 'script,style,textarea,[translate="no"],.mono,.vin';
const ATTRS = ['placeholder', 'title', 'aria-label'];

function translateNode(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const p = node.parentElement;
    if (!p || p.closest(SKIP)) return;
    const next = tr(node.nodeValue);
    if (next !== node.nodeValue) node.nodeValue = next;
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE || node.closest(SKIP)) return;
  for (const a of ATTRS) {
    if (node.hasAttribute(a)) {
      const v = node.getAttribute(a);
      const next = tr(v);
      if (next !== v) node.setAttribute(a, next);
    }
  }
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (n.nodeType === Node.ELEMENT_NODE && n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      const next = tr(n.nodeValue);
      if (next !== n.nodeValue) n.nodeValue = next;
    } else {
      for (const a of ATTRS) {
        if (n.hasAttribute(a)) {
          const v = n.getAttribute(a);
          const next = tr(v);
          if (next !== v) n.setAttribute(a, next);
        }
      }
    }
  }
}

/** Translate the page now and everything added to it later. */
export function startTranslator() {
  document.documentElement.lang = lang === 'no' ? 'nb' : 'en';
  translateNode(document.body);
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') translateNode(r.target);
      else if (r.type === 'attributes') translateNode(r.target);
      else r.addedNodes.forEach(translateNode);
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });

  // Native dialogs too.
  const { confirm: c, prompt: p, alert: a } = window;
  window.confirm = (msg) => c.call(window, tr(msg));
  window.prompt = (msg, def) => p.call(window, tr(msg), def);
  window.alert = (msg) => a.call(window, tr(msg));
}
