/* Shared game data – loaded by the server (require) and the browser (<script>).
   All card text is original, written for a walking game in Vilnius. Edit freely. */
(function (root) {
  'use strict';

  // Fixed points used by "Measuring" questions. The app uses them to suggest answers
  // to the hider and to draw circles for the seekers.
  const LANDMARKS = {
    tower:      { name: 'Gediminas Tower',            lat: 54.68672, lng: 25.29071 },
    cathedral:  { name: 'Vilnius Cathedral',          lat: 54.68577, lng: 25.28766 },
    townhall:   { name: 'Town Hall (Rotušė)',          lat: 54.67744, lng: 25.28700 },
    dawn:       { name: 'Gates of Dawn',              lat: 54.67418, lng: 25.28935 },
    station:    { name: 'Railway station',            lat: 54.67067, lng: 25.28447 },
    hales:      { name: 'Halės market',               lat: 54.67710, lng: 25.28480 },
    lukiskes:   { name: 'Lukiškės Square',            lat: 54.68957, lng: 25.27063 },
    university: { name: 'Vilnius University courtyard', lat: 54.68247, lng: 25.28782 },
    seimas:     { name: 'Seimas (Parliament)',        lat: 54.69130, lng: 25.26270 },
  };

  // ---------- Seeker questions ----------
  // answer: yesno | closer | hotter | photo | text
  // reward: how many cards the hider draws / keeps after answering.
  const QUESTIONS = {
    matching: {
      label: 'Matching', short: 'Same as ours?', color: '#6FA8DC',
      answer: 'yesno', minutes: 5, reward: { draw: 3, keep: 1 },
      blurb: 'Is your nearest thing the same as ours?',
      items: [
        { id: 'ma-church',   text: 'Is your nearest church the same as our nearest church?' },
        { id: 'ma-museum',   text: 'Is your nearest museum or gallery the same as ours?' },
        { id: 'ma-square',   text: 'Is your nearest park or public square the same as ours?' },
        { id: 'ma-bridge',   text: 'Is your nearest bridge the same as ours?' },
        { id: 'ma-hotel',    text: 'Is your nearest hotel the same as ours?' },
        { id: 'ma-stop',     text: 'Is your nearest bus or trolleybus stop (by name) the same as ours?' },
        { id: 'ma-super',    text: 'Is the chain of your nearest supermarket (Maxima, Rimi, Iki, Lidl, Norfa...) the same as ours?' },
        { id: 'ma-pharmacy', text: 'Is the chain of your nearest pharmacy the same as ours?' },
        { id: 'ma-monument', text: 'Is your nearest monument or statue the same as ours?' },
        { id: 'ma-stage',    text: 'Is your nearest theatre or cinema the same as ours?' },
        { id: 'ma-embassy',  text: 'Is your nearest embassy or consulate the same as ours?' },
        { id: 'ma-letter',   text: 'Does the street you are on start with the same letter as ours?' },
      ],
    },
    measuring: {
      label: 'Measuring', short: 'Closer or further?', color: '#93C47D',
      answer: 'closer', minutes: 5, reward: { draw: 3, keep: 1 },
      blurb: 'Compared to us, are you closer to or further from something?',
      items: [
        { id: 'me-tower',      text: 'Compared to us, are you closer to or further from Gediminas Tower?', landmark: 'tower' },
        { id: 'me-cathedral',  text: 'Compared to us, are you closer to or further from the Cathedral?', landmark: 'cathedral' },
        { id: 'me-townhall',   text: 'Compared to us, are you closer to or further from the Town Hall?', landmark: 'townhall' },
        { id: 'me-dawn',       text: 'Compared to us, are you closer to or further from the Gates of Dawn?', landmark: 'dawn' },
        { id: 'me-station',    text: 'Compared to us, are you closer to or further from the railway station?', landmark: 'station' },
        { id: 'me-hales',      text: 'Compared to us, are you closer to or further from Halės market?', landmark: 'hales' },
        { id: 'me-lukiskes',   text: 'Compared to us, are you closer to or further from Lukiškės Square?', landmark: 'lukiskes' },
        { id: 'me-university', text: 'Compared to us, are you closer to or further from the Vilnius University courtyard?', landmark: 'university' },
        { id: 'me-seimas',     text: 'Compared to us, are you closer to or further from the Seimas?', landmark: 'seimas' },
        { id: 'me-neris',      text: 'Compared to us, are you closer to or further from the Neris river?' },
        { id: 'me-church',     text: 'Compared to us, are you closer to or further from your nearest church?' },
        { id: 'me-mcd',        text: 'Compared to us, are you closer to or further from the nearest McDonald\'s?' },
        { id: 'me-super',      text: 'Compared to us, are you closer to or further from the nearest supermarket?' },
      ],
    },
    radar: {
      label: 'Radar', short: 'Within X metres?', color: '#F6B26B',
      answer: 'yesno', minutes: 5, reward: { draw: 2, keep: 1 },
      blurb: 'Are you within a set distance of us?',
      items: [
        { id: 'ra-100',  meters: 100,  text: 'Are you within 100 m of us?' },
        { id: 'ra-200',  meters: 200,  text: 'Are you within 200 m of us?' },
        { id: 'ra-300',  meters: 300,  text: 'Are you within 300 m of us?' },
        { id: 'ra-500',  meters: 500,  text: 'Are you within 500 m of us?' },
        { id: 'ra-750',  meters: 750,  text: 'Are you within 750 m of us?' },
        { id: 'ra-1000', meters: 1000, text: 'Are you within 1 km of us?' },
        { id: 'ra-1500', meters: 1500, text: 'Are you within 1.5 km of us?' },
        { id: 'ra-custom', meters: null, text: 'Are you within {m} m of us?', custom: true },
      ],
    },
    thermometer: {
      label: 'Thermometer', short: 'Hotter or colder?', color: '#E06666',
      answer: 'hotter', minutes: 5, reward: { draw: 2, keep: 1 },
      blurb: 'Walk a set distance, then ask if you got closer.',
      items: [
        { id: 'th-100', meters: 100, text: 'We walked 100 m. Are we hotter or colder?' },
        { id: 'th-150', meters: 150, text: 'We walked 150 m. Are we hotter or colder?' },
        { id: 'th-200', meters: 200, text: 'We walked 200 m. Are we hotter or colder?' },
        { id: 'th-300', meters: 300, text: 'We walked 300 m. Are we hotter or colder?' },
        { id: 'th-500', meters: 500, text: 'We walked 500 m. Are we hotter or colder?' },
      ],
    },
    photo: {
      label: 'Photo', short: 'Send a picture', color: '#C27BA0',
      answer: 'photo', minutes: 10, reward: { draw: 1, keep: 1 },
      blurb: 'Send us a photo of something near you.',
      items: [
        { id: 'ph-tallest', text: 'Send a photo of the tallest building you can see.' },
        { id: 'ph-sign',    text: 'Send a photo of the nearest street name sign.' },
        { id: 'ph-sky',     text: 'Send a photo straight up at the sky.' },
        { id: 'ph-ground',  text: 'Send a photo of the ground at your feet.' },
        { id: 'ph-door',    text: 'Send a photo of the nearest door.' },
        { id: 'ph-tree',    text: 'Send a photo of the nearest tree.' },
        { id: 'ph-shop',    text: 'Send a photo of the nearest shop or café sign.' },
        { id: 'ph-church',  text: 'Send a photo of any church you can see (or of the view if none is visible).' },
        { id: 'ph-light',   text: 'Send a photo of the nearest street lamp.' },
        { id: 'ph-window',  text: 'Send a photo of the most interesting window you can see.' },
      ],
    },
    tentacles: {
      label: 'Tentacles', short: 'Which one?', color: '#8E7CC3',
      answer: 'text', minutes: 5, reward: { draw: 4, keep: 2 },
      blurb: 'Of all the places of a kind near us, which one are you closest to?',
      items: [
        { id: 'te-church',   text: 'Of all churches within 500 m of us, which one are you closest to?' },
        { id: 'te-museum',   text: 'Of all museums within 500 m of us, which one are you closest to?' },
        { id: 'te-monument', text: 'Of all monuments and statues within 500 m of us, which one are you closest to?' },
        { id: 'te-square',   text: 'Of all parks and squares within 500 m of us, which one are you closest to?' },
        { id: 'te-hotel',    text: 'Of all hotels within 300 m of us, which one are you closest to?' },
        { id: 'te-embassy',  text: 'Of all embassies within 1 km of us, which one are you closest to?' },
      ],
    },
  };

  // ---------- Hider deck ----------
  // kind: time | veto | randomize | swap | expand | move | curse
  const DECK = [];
  const add = (card, copies) => { for (let i = 0; i < copies; i++) DECK.push(card); };

  [[2, 8], [3, 6], [5, 4], [8, 2], [12, 1]].forEach(([min, n]) => add({
    id: 'time-' + min, kind: 'time', name: '+' + min + ' minutes', minutes: min,
    text: 'Keep this in your hand. If you are still holding it when you are found, ' + min + ' minutes are added to your time.',
  }, n));

  add({ id: 'pw-veto', kind: 'veto', name: 'Veto',
    text: 'Play while a question is waiting. You refuse to answer it. You draw nothing for it either.' }, 4);
  add({ id: 'pw-random', kind: 'randomize', name: 'Randomize',
    text: 'Play while a question is waiting. It is replaced by a random unused question of the same type.' }, 4);
  add({ id: 'pw-d1d2', kind: 'swap', name: 'Discard 1, draw 2', discard: 1, draw: 2,
    text: 'Discard one other card from your hand, then draw two.' }, 3);
  add({ id: 'pw-d2d3', kind: 'swap', name: 'Discard 2, draw 3', discard: 2, draw: 3,
    text: 'Discard two other cards from your hand, then draw three.' }, 2);
  add({ id: 'pw-expand', kind: 'expand', name: 'Bigger pockets', draw: 1,
    text: 'Draw one card and hold one more card than before for the rest of the round.' }, 2);
  add({ id: 'pw-move', kind: 'move', name: 'Relocate',
    text: 'Leave your hiding zone. Seekers must stop where they are while you walk to a new spot (10 minutes max), then lock a new zone.' }, 1);

  const curse = (id, name, text, extra) => add(Object.assign({ id: 'cu-' + id, kind: 'curse', name, text }, extra), 1);
  curse('bell', 'Curse of the bell tower',
    'Before asking another question, the seekers send a photo of a bell tower.', { block: true });
  curse('stroll', 'Curse of the evening stroll',
    'The seekers may not run or jog until they have asked another question.', { discard: 1 });
  curse('left', 'Curse of left turns',
    'For 10 minutes the seekers may only go straight or turn left at crossings.', { minutes: 10, discard: 1 });
  curse('silent', 'Curse of the silent square',
    'For 10 minutes the seekers may not speak to each other. Gestures are fine.', { minutes: 10 });
  curse('statue', 'Curse of the living statue',
    'Before asking another question, one seeker copies the pose of a statue and the team sends the photo.', { block: true, discard: 1 });
  curse('snack', 'Curse of the hungry tourist',
    'Before asking another question, the seekers buy something local to eat or drink (kibinas, šakotis, gira...) and send a photo of it.', { block: true, discard: 1 });
  curse('freeze', 'Curse of the frozen clock',
    'The app rolls a die. The seekers stand still for that many minutes.', { roll: true });
  curse('compass', 'Curse of the compass',
    'You name a direction. Before asking another question, the seekers walk at least 150 m that way.', { block: true, discard: 1, input: 'direction' });
  curse('courtyard', 'Curse of the courtyard',
    'Before asking another question, the seekers walk through an archway into a courtyard and send a photo from inside.', { block: true });
  curse('stranger', 'Curse of the group photo',
    'Before asking another question, the seekers ask a stranger to take a photo of the whole team and send it.', { block: true, discard: 1 });
  curse('letter', 'Curse of the street sign',
    'You pick a letter. Before asking another question, the seekers stand on a street starting with that letter and send a photo of its sign.', { block: true, discard: 1, input: 'letter' });
  curse('fog', 'Curse of the fog',
    'For 10 minutes the seekers\' map is hidden.', { minutes: 10, blind: true, discard: 1 });
  curse('language', 'Curse of the translator',
    'You pick a language. The seekers\' next question must be said out loud in it (send a voice message).', { input: 'language' });
  curse('view', 'Curse of the high ground',
    'Before asking another question, the seekers climb stairs or a slope and send a photo of the view from above street level.', { block: true, discard: 1 });
  curse('bird', 'Curse of the pigeon',
    'Before asking another question, the seekers send a photo of a bird.', { block: true });
  curse('coin', 'Curse of the coin',
    'The app flips a coin. Tails means the seekers\' next question is answered with silence (you still draw for it).', { coin: true, discard: 1 });

  const CARD_BY_ID = {};
  DECK.forEach((c) => { CARD_BY_ID[c.id] = c; });

  const QUESTION_BY_ID = {};
  Object.entries(QUESTIONS).forEach(([cat, def]) => def.items.forEach((q) => { QUESTION_BY_ID[q.id] = Object.assign({ cat }, q); }));

  const RULES = [
    'One player (or a small team) hides, everyone else seeks. Everyone walks. No transport, no bikes, no scooters.',
    'The hider gets the hiding time to walk anywhere inside the play area and lock a hiding zone. The zone is a circle around where the hider stands when they lock it.',
    'When hiding time ends, seekers may leave the start. The clock runs until the hider is found.',
    'Seekers ask one question at a time. Each question can be asked only once per round. The hider has 5 minutes to answer (10 for photos) and draws cards as a reward.',
    'Hider cards are time bonuses (kept until the end), power ups and curses. Curses slow the seekers down.',
    'Once any seeker walks into the hiding zone, the app tells everyone. From then on the hider may not move.',
    'The hider is found when a seeker sees and names them. Press Found. Longest total time wins.',
    'Stay on public streets and open courtyards. No entering homes, paid venues or closed areas. Watch the traffic, it is dark.',
  ];

  const api = { LANDMARKS, QUESTIONS, DECK, CARD_BY_ID, QUESTION_BY_ID, RULES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CARDS = api;
})(typeof window !== 'undefined' ? window : globalThis);
