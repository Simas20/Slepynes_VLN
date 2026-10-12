/* Play area. Coordinates are [lat, lng], traced by hand and approximate.
   Walk or check the edges on the map before the game and adjust if needed.

   Senamiestis   Neris bank (Lukiškės to the Vilnia mouth), Vilnia river on the east,
                 Gates of Dawn and the station on the south, Pylimo / Vilniaus g. on the west.
                 Užupis (east of the Vilnia) is NOT included.
   Naujamiestis  West of Pylimo g. Gedimino pr. west part, Tauras hill, Naugarduko,
                 down to the railway, west to the Vingis park entrance and the Seimas. */
window.ZONES = {
  start: { name: 'Cathedral Square', lat: 54.68577, lng: 25.28766 },
  areas: {
    senamiestis: {
      name: 'Senamiestis',
      color: '#F2A33A',
      optional: false,
      coords: [
        [54.6905, 25.2705], [54.6903, 25.2745], [54.6898, 25.2786], [54.6890, 25.2860],
        [54.6893, 25.2905], [54.6875, 25.2945], [54.6845, 25.2950], [54.6815, 25.2935],
        [54.6785, 25.2945], [54.6755, 25.2955], [54.6735, 25.2920], [54.6728, 25.2880],
        [54.6712, 25.2850], [54.6720, 25.2800], [54.6745, 25.2770], [54.6790, 25.2745],
        [54.6835, 25.2730], [54.6870, 25.2705],
      ],
    },
    naujamiestis: {
      name: 'Naujamiestis',
      color: '#5FC3B4',
      optional: true,
      coords: [
        [54.6905, 25.2705], [54.6870, 25.2705], [54.6835, 25.2730], [54.6790, 25.2745],
        [54.6745, 25.2770], [54.6720, 25.2800], [54.6712, 25.2850], [54.6700, 25.2840],
        [54.6695, 25.2780], [54.6690, 25.2700], [54.6685, 25.2620], [54.6700, 25.2530],
        [54.6740, 25.2470], [54.6790, 25.2450], [54.6830, 25.2445], [54.6865, 25.2510],
        [54.6895, 25.2560], [54.6915, 25.2610], [54.6915, 25.2660],
      ],
    },
  },
};
