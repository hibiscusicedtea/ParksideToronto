const DATA_URLS = [
  './data/parks.geojson',
  './data.geojson',
  './parks.geojson'
];

const PAGE_SIZE = 12;
const NEARBY_RADIUS_KM = 2;
const NEARBY_CATEGORIES = [
  {
    id: 'playground',
    label: 'Playgrounds',
    color: '#14532d',
    icon: 'smile',
    matches: (park, tags) => tags.includes('Playground')
  },
  {
    id: 'open-space',
    label: 'Open green space',
    color: '#176b3a',
    icon: 'map',
    matches: (park, tags) => prop(park, 'TYPE') === 'Park' && tags.length === 0
  },
  {
    id: 'picnic',
    label: 'Picnic spots',
    color: '#365314',
    icon: 'sun',
    matches: (park, tags) => tags.includes('Picnic Site')
  },
  {
    id: 'sports',
    label: 'Sports',
    color: '#065f46',
    icon: 'activity',
    matches: (park, tags) => tags.some((tag) => /ball diamond|sports field|court|pitch|track|disc golf|skateboarding|fitness equipment|ping pong|dry pad/i.test(tag))
  },
  {
    id: 'washroom',
    label: 'Washrooms',
    color: '#166534',
    icon: 'droplet',
    matches: (park, tags) => tags.includes('Washroom')
  }
];

const state = {
  parks: [],
  filtered: [],
  query: '',
  filter: 'all',
  sort: 'name',
  visible: PAGE_SIZE,
  selectedId: null,
  userPosition: null,
  nearbyParks: [],
  nearbyFilterIds: new Set()
};

const $ = (selector) => document.querySelector(selector);
const listEl = $('#park-list');
let selectedMap = null;
let nearbyMarkers = [];

function featherIcon(name, className = '') {
  const icon = window.feather?.icons?.[name];
  if (!icon) return '';

  return icon.toSvg({
    class: `feather-ui ${className}`.trim(),
    'aria-hidden': 'true',
    focusable: 'false'
  });
}

const escapeHtml = (value = '') =>
  String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);

function coords(park) {
  const raw = park.geometry?.coordinates;
  const point = Array.isArray(raw?.[0]) ? raw[0] : raw;

  if (
    !Array.isArray(point) ||
    point.length < 2 ||
    !Number.isFinite(Number(point[0])) ||
    !Number.isFinite(Number(point[1]))
  ) {
    return null;
  }

  return {
    lon: Number(point[0]),
    lat: Number(point[1])
  };
}

function renderParkMap(location, parkName) {
  const container = $('#selected-park-map');

  if (!container || !location) return;
  if (!window.maplibregl) {
    container.textContent = 'Map preview could not load. Use the full map link below.';
    return;
  }

  selectedMap = new maplibregl.Map({
    container,
    style: 'https://tiles.openfreemap.org/styles/positron',
    center: [location.lon, location.lat],
    zoom: 14,
    scrollZoom: false,
    attributionControl: false
  });

  const zoomControl = document.createElement('div');
  zoomControl.className = 'maplibregl-ctrl maplibregl-ctrl-group feather-map-controls';
  zoomControl.innerHTML = `
    <button type="button" aria-label="Zoom in">${featherIcon('plus')}</button>
    <button type="button" aria-label="Zoom out">${featherIcon('minus')}</button>
  `;
  const [zoomInButton, zoomOutButton] = zoomControl.querySelectorAll('button');
  zoomInButton.addEventListener('click', (event) => {
    event.stopPropagation();
    selectedMap?.zoomIn();
  });
  zoomOutButton.addEventListener('click', (event) => {
    event.stopPropagation();
    selectedMap?.zoomOut();
  });

  selectedMap.addControl({
    onAdd: () => zoomControl,
    onRemove: () => zoomControl.remove()
  }, 'top-right');

  const selectedMarker = document.createElement('span');
  selectedMarker.className = 'park-map-marker park-map-marker-selected';
  selectedMarker.innerHTML = featherIcon('map-pin', 'map-marker-icon');

  new maplibregl.Marker({ element: selectedMarker, anchor: 'center' })
    .setLngLat([location.lon, location.lat])
    .setPopup(new maplibregl.Popup({ offset: 14, closeButton: false }).setText(parkName))
    .addTo(selectedMap);

  selectedMap.on('load', updateNearbyResults);
}

function amenities(park) {
  const value = park.properties?.AMENITIES || '';

  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item && item.toLowerCase() !== 'none');
}

function prop(park, key, fallback = '') {
  return park.properties?.[key] ?? fallback;
}

function parkId(park, index) {
  return String(prop(park, 'LOCATIONID') || prop(park, '_id') || index);
}

function distanceKm(pointA, pointB) {
  const radians = (number) => number * Math.PI / 180;
  const deltaLat = radians(pointB.lat - pointA.lat);
  const deltaLon = radians(pointB.lon - pointA.lon);

  const value =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(radians(pointA.lat)) *
      Math.cos(radians(pointB.lat)) *
      Math.sin(deltaLon / 2) ** 2;

  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function requestUserPosition() {
  if (!navigator.geolocation) {
    return Promise.reject(new Error('Location is not available in this browser.'));
  }

  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({
        lat: position.coords.latitude,
        lon: position.coords.longitude
      }),
      reject,
      { timeout: 10000, maximumAge: 300000 }
    );
  });
}

function getNearbyParks(selectedPark, center) {
  return state.parks
    .filter((park) => park !== selectedPark)
    .map((park) => {
      const location = coords(park);
      if (!location) return null;

      const tags = amenities(park);
      const categories = NEARBY_CATEGORIES
        .filter((category) => category.matches(park, tags))
        .map((category) => category.id);

      return {
        park,
        location,
        tags,
        categories,
        distance: distanceKm(center, location),
        marker: null
      };
    })
    .filter((place) => place && place.distance <= NEARBY_RADIUS_KM && place.categories.length)
    .sort((a, b) => a.distance - b.distance);
}

function updateNearbyResults() {
  const filterContainer = $('#nearby-filters');
  const summary = $('#nearby-summary');
  const list = $('#nearby-list');
  if (!filterContainer || !summary || !list) return;

  filterContainer.querySelectorAll('[data-map-filter]').forEach((button) => {
    const active = state.nearbyFilterIds.has(button.dataset.mapFilter);
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', String(active));
  });

  nearbyMarkers.forEach((marker) => marker.remove());
  nearbyMarkers = [];

  const visible = state.nearbyParks.filter((place) =>
    place.categories.some((categoryId) => state.nearbyFilterIds.has(categoryId))
  );

  visible.forEach((place) => {
    const category = NEARBY_CATEGORIES.find((item) =>
      place.categories.includes(item.id) && state.nearbyFilterIds.has(item.id)
    );

    if (!selectedMap?.isStyleLoaded() || !category) return;

    const name = prop(place.park, 'ASSET_NAME', 'Nearby park');
    const markerElement = document.createElement('span');
    markerElement.className = 'park-map-marker';
    markerElement.style.color = category.color;
    markerElement.innerHTML = featherIcon(category.icon, 'map-marker-icon');

    const marker = new maplibregl.Marker({ element: markerElement, anchor: 'center' })
      .setLngLat([place.location.lon, place.location.lat])
      .setPopup(new maplibregl.Popup({ offset: 12, closeButton: false }).setHTML(
        `<strong>${escapeHtml(name)}</strong><br>${escapeHtml(place.tags.join(', '))}<br>${place.distance.toFixed(1)} km away`
      ))
      .addTo(selectedMap);

    nearbyMarkers.push(marker);
    place.marker = marker;
  });

  const results = visible.slice(0, 5);
  summary.textContent = visible.length
    ? `Showing ${results.length} of ${visible.length} nearby places · ${NEARBY_RADIUS_KM} km radius`
    : `No mapped places match these filters within ${NEARBY_RADIUS_KM} km.`;

  list.innerHTML = results.map((place, index) => {
    const name = prop(place.park, 'ASSET_NAME', 'Nearby park');
    const categoryLabels = place.categories
      .filter((categoryId) => state.nearbyFilterIds.has(categoryId))
      .map((categoryId) => NEARBY_CATEGORIES.find((category) => category.id === categoryId)?.label)
      .filter(Boolean);

    return `
      <button class="nearby-result" type="button" data-nearby-index="${index}">
        ${featherIcon('map-pin', 'nearby-result-icon')}
        <span class="nearby-result-name">${escapeHtml(name)}</span>
        <span class="nearby-result-meta">${place.distance.toFixed(1)} km · ${escapeHtml(categoryLabels.join(', '))}</span>
      </button>
    `;
  }).join('');

  list.querySelectorAll('[data-nearby-index]').forEach((button) => {
    button.addEventListener('click', () => {
      const place = results[Number(button.dataset.nearbyIndex)];
      if (!place || !selectedMap) return;

      selectedMap.flyTo({ center: [place.location.lon, place.location.lat], zoom: 16 });
      place.marker?.togglePopup();
    });
  });
}

function render() {
  const query = state.query.toLocaleLowerCase().trim();

  let parks = state.parks.filter((park) => {
    const name = prop(park, 'ASSET_NAME');
    const address = prop(park, 'ADDRESS');
    const tags = amenities(park);

    const matchesQuery =
      !query ||
      `${name} ${address} ${prop(park, 'TYPE')} ${tags.join(' ')}`
        .toLocaleLowerCase()
        .includes(query);

    const matchesFilter =
      state.filter === 'all' ||
      (state.filter === 'open-space'
        ? prop(park, 'TYPE') === 'Park' && tags.length === 0
        : tags.some((tag) =>
            tag.toLocaleLowerCase().includes(state.filter.toLocaleLowerCase())
          ));

    return matchesQuery && matchesFilter;
  });

  if (state.sort === 'amenities') {
    parks.sort(
      (a, b) =>
        amenities(b).length - amenities(a).length ||
        prop(a, 'ASSET_NAME').localeCompare(prop(b, 'ASSET_NAME'))
    );
  } else if (state.sort === 'distance' && state.userPosition) {
    parks.sort((a, b) => {
      const coordsA = coords(a);
      const coordsB = coords(b);

      if (!coordsA) return 1;
      if (!coordsB) return -1;

      return (
        distanceKm(coordsA, state.userPosition) -
        distanceKm(coordsB, state.userPosition)
      );
    });
  } else {
    parks.sort((a, b) =>
      prop(a, 'ASSET_NAME').localeCompare(prop(b, 'ASSET_NAME'))
    );
  }

  state.filtered = parks;

  $('#results-count').textContent =
    `Showing ${parks.length.toLocaleString()} ${parks.length === 1 ? 'park' : 'parks'}`;

  $('#count-note').textContent =
    `${state.parks.length.toLocaleString()} parks & recreation spaces across Toronto`;

  $('#all-count').textContent = state.parks.length.toLocaleString();
  $('#empty-state').hidden = parks.length > 0;
  $('#load-more').hidden = parks.length <= state.visible;

  listEl.innerHTML = parks
    .slice(0, state.visible)
    .map((park, index) => {
      const id = parkId(park, state.parks.indexOf(park));
      const tags = amenities(park);

      return `
        <article
          class="park-card${state.selectedId === id ? ' active' : ''}"
          role="button"
          tabindex="0"
          data-id="${escapeHtml(id)}"
          aria-label="View ${escapeHtml(prop(park, 'ASSET_NAME'))}"
        >
          <span class="card-index">${String(index + 1).padStart(2, '0')}</span>
          <div class="park-type">${escapeHtml(prop(park, 'TYPE', 'Park'))}</div>
          <h3 class="park-name">${escapeHtml(prop(park, 'ASSET_NAME', 'Toronto park'))}</h3>
          <p class="park-address">${escapeHtml(prop(park, 'ADDRESS', 'Toronto, ON'))}</p>
          <div class="amenity-row">
            ${
              tags.length
                ? tags.slice(0, 3).map((tag) =>
                    `<span class="amenity-tag">${escapeHtml(tag)}</span>`
                  ).join('')
                : '<span class="amenity-tag none">Open green space</span>'
            }
            ${tags.length > 3 ? `<span class="amenity-tag">+${tags.length - 3}</span>` : ''}
          </div>
          <span class="card-chevron">${featherIcon('arrow-up-right')}</span>
        </article>
      `;
    })
    .join('');

  listEl.querySelectorAll('.park-card').forEach((card) => {
    const activate = () => selectPark(card.dataset.id);

    card.addEventListener('click', activate);
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
      }
    });
  });
}

function closeParkDetails() {
  const selectedId = state.selectedId;
  const restoreFocus = document.body.classList.contains('detail-modal-open');
  const panel = $('#detail-panel');

  panel.classList.remove('is-open');
  panel.removeAttribute('role');
  panel.removeAttribute('aria-modal');
  $('#detail-backdrop').hidden = true;
  document.body.classList.remove('detail-modal-open');

  if (selectedMap) {
    selectedMap.remove();
    selectedMap = null;
    nearbyMarkers = [];
  }

  render();

  if (restoreFocus && selectedId) {
    const selectedCard = [...document.querySelectorAll('.park-card')]
      .find((card) => card.dataset.id === selectedId);
    selectedCard?.focus({ preventScroll: true });
  }
}

function selectPark(id) {
  const parkIndex = state.parks.findIndex(
    (park, index) => parkId(park, index) === String(id)
  );

  if (parkIndex === -1) return;

  const park = state.parks[parkIndex];
  const location = coords(park);
  const tags = amenities(park);
  const cityUrl = prop(park, 'URL');
  const parkName = prop(park, 'ASSET_NAME', 'Toronto park');
  const nearbyParks = location ? getNearbyParks(park, location) : [];
  const nearbyCounts = NEARBY_CATEGORIES
    .map((category) => ({
      category,
      count: nearbyParks.filter((place) => place.categories.includes(category.id)).length
    }))
    .sort((a, b) => b.count - a.count);

  state.nearbyParks = nearbyParks;
  state.nearbyFilterIds = new Set(
    nearbyCounts.filter((item) => item.count > 0).map((item) => item.category.id)
  );

  if (selectedMap) {
    selectedMap.remove();
    selectedMap = null;
    nearbyMarkers = [];
  }

  state.selectedId = String(id);

  const mapUrl = location
    ? `https://www.openstreetmap.org/?mlat=${location.lat}&mlon=${location.lon}#map=16/${location.lat}/${location.lon}`
    : '#';

  $('#detail-content').innerHTML = `
    <div class="detail-illustration">
      ${
        location
          ? `<div
              class="park-map"
              id="selected-park-map"
              role="region"
              aria-label="Interactive map showing ${escapeHtml(parkName)} in Toronto"
            ></div>`
          : '<div class="map-unavailable">Location coordinates are unavailable.</div>'
      }
      <div class="photo-caption map-caption">
        <span>${escapeHtml(parkName)}</span>
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OPENSTREETMAP</a>
        <a href="https://openfreemap.org/" target="_blank" rel="noreferrer">OPENFREEMAP</a>
        <a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">OPENMAPTILES</a>
      </div>
    </div>

    <div class="detail-selected">
      <div class="detail-type">${escapeHtml(prop(park, 'TYPE', 'Park'))}</div>
      <h3 class="detail-title">${escapeHtml(prop(park, 'ASSET_NAME', 'Toronto park'))}</h3>
      <p class="detail-address">${escapeHtml(prop(park, 'ADDRESS', 'Toronto, ON'))}</p>

      <div class="detail-amenities">
        ${
          tags.length
            ? tags.map((tag) =>
                `<span class="amenity-tag">${escapeHtml(tag)}</span>`
              ).join('')
            : '<span class="amenity-tag none">Open green space</span>'
        }
      </div>

      <section class="nearby-section" aria-label="Nearby amenities">
        <div class="nearby-section-head">
          <h4>Nearby amenities</h4>
          <span>${NEARBY_RADIUS_KM} km radius</span>
        </div>
        <div class="nearby-filters" id="nearby-filters">
          ${nearbyCounts.map(({ category, count }) => {
            const active = state.nearbyFilterIds.has(category.id);

            return `
              <button
                class="map-filter-chip${active ? ' selected' : ''}"
                type="button"
                data-map-filter="${category.id}"
                aria-pressed="${active}"
                ${count === 0 ? 'disabled' : ''}
              >
                <span class="map-filter-icon" style="color: ${category.color}">${featherIcon(category.icon)}</span>
                <span>${category.label}</span>
                <span class="map-filter-count">${count}</span>
              </button>
            `;
          }).join('')}
        </div>
        <p class="nearby-summary" id="nearby-summary"></p>
        <div class="nearby-list" id="nearby-list"></div>
      </section>

      ${
        cityUrl
          ? `<a class="map-link" href="${escapeHtml(cityUrl)}" target="_blank" rel="noreferrer">City park details ${featherIcon('external-link')}</a>`
          : ''
      }

      <div class="detail-divider"></div>

      <div class="weather-heading">
        <h4>Park weather</h4>
        <a class="data-credit" href="https://open-meteo.com/" target="_blank" rel="noreferrer">
          OPEN-METEO
        </a>
      </div>
      <div class="weather-card">
        <p class="weather-status" id="weather-status" role="status">
          <span class="weather-loading-icon">${featherIcon('cloud')}</span>
          Loading the local forecast…
        </p>
        <div class="weather-grid" id="weather-data" hidden></div>
      </div>
      <p class="weather-credit">Forecast data: Open-Meteo · CC BY 4.0</p>

      <div class="detail-divider"></div>

      <a class="map-link" href="${mapUrl}" target="_blank" rel="noreferrer">
        Open park in map ${featherIcon('external-link')}
      </a>
    </div>
  `;

  const detailPanel = $('#detail-panel');
  const isPhone = matchMedia('(max-width: 650px)').matches;
  detailPanel.classList.add('is-open');

  if (isPhone) {
    detailPanel.setAttribute('role', 'dialog');
    detailPanel.setAttribute('aria-modal', 'true');
    $('#detail-backdrop').hidden = false;
    document.body.classList.add('detail-modal-open');
  } else {
    detailPanel.removeAttribute('role');
    detailPanel.removeAttribute('aria-modal');
    $('#detail-backdrop').hidden = true;
    document.body.classList.remove('detail-modal-open');
  }

  render();
  renderParkMap(location, parkName);
  updateNearbyResults();

  $('#nearby-filters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-map-filter]');
    if (!button || button.disabled) return;

    const categoryId = button.dataset.mapFilter;
    if (state.nearbyFilterIds.has(categoryId)) {
      state.nearbyFilterIds.delete(categoryId);
    } else {
      state.nearbyFilterIds.add(categoryId);
    }

    updateNearbyResults();
  });

  if (location) {
    loadParkWeather(location);
  }

  if (isPhone) {
    $('#close-detail').focus({ preventScroll: true });
  }
}

function weatherDescription(code) {
  const descriptions = {
    0: 'Clear sky',
    1: 'Mostly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Foggy',
    48: 'Icy fog',
    51: 'Light drizzle',
    53: 'Drizzle',
    55: 'Heavy drizzle',
    56: 'Freezing drizzle',
    57: 'Heavy freezing drizzle',
    61: 'Light rain',
    63: 'Rain',
    65: 'Heavy rain',
    66: 'Freezing rain',
    67: 'Heavy freezing rain',
    71: 'Light snow',
    73: 'Snow',
    75: 'Heavy snow',
    77: 'Snow grains',
    80: 'Rain showers',
    81: 'Showers',
    82: 'Heavy showers',
    85: 'Snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with hail',
    99: 'Thunderstorm with heavy hail'
  };

  return descriptions[code] || 'Current conditions';
}

function weatherIcon(code) {
  if (code === 0) return 'sun';
  if (code === 1 || code === 2 || code === 3) return 'cloud';
  if (code === 45 || code === 48) return 'wind';
  if (code >= 51 && code <= 57) return 'cloud-drizzle';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'cloud-rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'cloud-snow';
  if (code >= 95) return 'cloud-lightning';
  return 'cloud';
}

async function loadParkWeather(location) {
  const status = $('#weather-status');
  const container = $('#weather-data');

  if (!status || !container) return;

  try {
    const params = new URLSearchParams({
      latitude: location.lat,
      longitude: location.lon,
      current: 'temperature_2m,apparent_temperature,precipitation,wind_speed_10m,weather_code',
      daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      temperature_unit: 'celsius',
      wind_speed_unit: 'kmh',
      precipitation_unit: 'mm',
      timezone: 'auto'
    });

    const response = await fetch(
      `https://api.open-meteo.com/v1/forecast?${params}`,
      {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(9000)
      }
    );

    if (!response.ok) {
      throw new Error(`Open-Meteo returned ${response.status}`);
    }

    const data = await response.json();
    const current = data.current;
    const daily = data.daily;

    if (!current || !daily) {
      throw new Error('Forecast data was incomplete');
    }

    status.hidden = true;
    container.hidden = false;

    container.innerHTML = `
      <div class="weather-now">
        <div class="weather-icon">
          ${featherIcon(weatherIcon(current.weather_code), 'weather-condition-icon')}
        </div>
        <div class="weather-current">
          <span class="weather-current-label">RIGHT NOW</span>
          <div class="weather-reading">
            <div class="weather-temp">${Math.round(current.temperature_2m)}<span>°C</span></div>
            <div class="weather-conditions">
              <strong>${escapeHtml(weatherDescription(current.weather_code))}</strong>
              <span class="weather-feels">${featherIcon('thermometer')} Feels like ${Math.round(current.apparent_temperature)}°C</span>
            </div>
          </div>
        </div>
      </div>
      <div class="weather-stats">
        <div class="weather-stat">
          ${featherIcon('wind', 'weather-stat-icon')}
          <span class="weather-stat-label">WIND</span>
          <strong>${Math.round(current.wind_speed_10m)} km/h</strong>
        </div>
        <div class="weather-stat">
          ${featherIcon('thermometer', 'weather-stat-icon')}
          <span class="weather-stat-label">TODAY'S RANGE</span>
          <strong>${Math.round(daily.temperature_2m_min[0])}°–${Math.round(daily.temperature_2m_max[0])}°C</strong>
        </div>
        <div class="weather-stat">
          ${featherIcon('cloud-rain', 'weather-stat-icon')}
          <span class="weather-stat-label">RAIN CHANCE</span>
          <strong>${Math.round(daily.precipitation_probability_max[0] || 0)}%</strong>
        </div>
      </div>
    `;
  } catch (error) {
    status.hidden = false;
    status.innerHTML = `${featherIcon('cloud-off', 'weather-error-icon')} Weather is temporarily unavailable. Try again later.`;
    container.hidden = true;
    container.innerHTML = '';
  }
}

$('#search-input').addEventListener('input', (event) => {
  state.query = event.target.value;
  state.visible = PAGE_SIZE;
  render();
});

$('#search-input').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.target.value = '';
    state.query = '';
    render();
  }
});

document.addEventListener('keydown', (event) => {
  if (document.body.classList.contains('detail-modal-open')) {
    const panel = $('#detail-panel');

    if (event.key === 'Escape') {
      event.preventDefault();
      closeParkDetails();
      return;
    }

    if (event.key === 'Tab') {
      const focusable = [...panel.querySelectorAll('a[href], button:not(:disabled), select, input')]
        .filter((element) => element.offsetParent !== null);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  }

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    $('#search-input').focus();
  }
});

function setActiveSection(sectionId) {
  document.querySelectorAll('.nav-link').forEach((link) => {
    const active = link.hash === `#${sectionId}`;
    link.classList.toggle('active', active);

    if (active) {
      link.setAttribute('aria-current', 'location');
    } else {
      link.removeAttribute('aria-current');
    }
  });
}

document.querySelectorAll('.nav-link').forEach((link) => {
  link.addEventListener('click', () => setActiveSection(link.hash.slice(1)));
});

const initialSection = location.hash ? document.querySelector(location.hash) : null;
setActiveSection(initialSection?.id || 'explore');

if ('IntersectionObserver' in window) {
  const activeSectionObserver = new IntersectionObserver((entries) => {
    const visibleSection = entries
      .filter((entry) => entry.isIntersecting)
      .sort((first, second) => second.intersectionRatio - first.intersectionRatio)[0];

    if (visibleSection) setActiveSection(visibleSection.target.id);
  }, {
    rootMargin: `-${document.querySelector('.topbar').offsetHeight}px 0px -${Math.round(window.innerHeight * .55)}px 0px`,
    threshold: 0
  });

  document.querySelectorAll('#explore, #how-it-works').forEach((section) => {
    activeSectionObserver.observe(section);
  });
}

$('#filters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-filter]');
  if (!button) return;

  state.filter = button.dataset.filter;
  state.visible = PAGE_SIZE;

  document.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.classList.toggle('selected', chip === button);
  });

  const filterStrip = $('#filters');
  if (matchMedia('(max-width: 650px)').matches) {
    const stripBounds = filterStrip.getBoundingClientRect();
    const buttonBounds = button.getBoundingClientRect();
    const leftPadding = parseFloat(getComputedStyle(filterStrip).paddingLeft) || 0;
    const left = filterStrip.scrollLeft + buttonBounds.left - stripBounds.left - leftPadding;

    filterStrip.scrollTo({
      left: Math.max(0, left),
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    });
  }

  render();
});

$('#sort-select').addEventListener('change', (event) => {
  const sort = event.target.value;
  const status = $('#sort-status');

  if (sort !== 'distance') {
    state.sort = sort;
    status.textContent = '';
    render();
    return;
  }

  if (state.userPosition) {
    state.sort = 'distance';
    status.textContent = 'Sorted nearest to you.';
    render();
    return;
  }

  const previousSort = state.sort;
  event.target.disabled = true;
  status.textContent = 'Requesting your location…';

  requestUserPosition()
    .then((position) => {
      state.userPosition = position;
      state.sort = 'distance';
      status.textContent = 'Sorted nearest to you.';
    })
    .catch(() => {
      state.sort = previousSort;
      event.target.value = previousSort;
      status.textContent = 'Location unavailable. Allow access to sort by distance.';
    })
    .finally(() => {
      event.target.disabled = false;
      render();
    });
});

$('#load-more').addEventListener('click', () => {
  state.visible += PAGE_SIZE;
  render();
});

$('#clear-search').addEventListener('click', () => {
  state.query = '';
  state.filter = 'all';
  $('#search-input').value = '';

  document.querySelectorAll('.filter-chip').forEach((button) => {
    button.classList.toggle('selected', button.dataset.filter === 'all');
  });

  render();
});

$('#close-detail').addEventListener('click', closeParkDetails);
$('#detail-backdrop').addEventListener('click', closeParkDetails);

$('#location-button').addEventListener('click', async () => {
  const buttonLabel = $('#location-button').lastElementChild;
  const status = $('#sort-status');
  buttonLabel.textContent = 'Finding you…';

  try {
    state.userPosition = await requestUserPosition();
    state.sort = 'distance';
    $('#sort-select').value = 'distance';
    status.textContent = 'Sorted nearest to you.';
    buttonLabel.textContent = 'Sorting nearby';
    render();
  } catch (error) {
    buttonLabel.textContent = 'Use my location';
    status.textContent = 'Location unavailable. Allow access to sort by distance.';
  }
});

window.feather?.replace();

async function loadParkData() {
  let lastError;

  for (const url of DATA_URLS) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url} returned ${response.status}`);

      const data = await response.json();

      if (!Array.isArray(data.features) || data.features.length === 0) {
        throw new Error(`${url} has no park features`);
      }

      return data.features;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Toronto parks data could not be loaded');
}

loadParkData()
  .then((features) => {
    state.parks = features;
    render();
  })
  .catch(() => {
    $('#count-note').textContent =
      'Park data could not be loaded. Keep the GeoJSON at data/parks.geojson and run the site with Live Server.';
    $('#results-count').textContent = 'Data unavailable';
    $('#all-count').textContent = '—';
  });
