import {
  createOptimizedPicture,
  decorateIcons,
  fetchPlaceholders,
} from '../../scripts/aem.js';

// Global for capturing "?q=..." from the URL
const searchParams = new URLSearchParams(window.location.search);

/**
 * Finds the next heading level based on existing headings in the DOM.
 */
function findNextHeading(el) {
  let preceedingEl = el.parentElement.previousElement || el.parentElement.parentElement;
  let h = 'H2';
  while (preceedingEl) {
    const lastHeading = [...preceedingEl.querySelectorAll('h1, h2, h3, h4, h5, h6')].pop();
    if (lastHeading) {
      const level = parseInt(lastHeading.nodeName[1], 10);
      h = level < 6 ? `H${level + 1}` : 'H6';
      preceedingEl = false;
    } else {
      preceedingEl = preceedingEl.previousElement || preceedingEl.parentElement;
    }
  }
  return h;
}

/**
 * Highlights terms inside text nodes by wrapping matches in <mark>.
 */
function highlightTextElements(terms, elements) {
  elements.forEach((element) => {
    if (!element || !element.textContent) return;

    const matches = [];
    const { textContent } = element;
    terms.forEach((term) => {
      let start = 0;
      let offset = textContent.toLowerCase().indexOf(term.toLowerCase(), start);
      while (offset >= 0) {
        matches.push({ offset, term: textContent.substring(offset, offset + term.length) });
        start = offset + term.length;
        offset = textContent.toLowerCase().indexOf(term.toLowerCase(), start);
      }
    });

    if (!matches.length) {
      return;
    }

    matches.sort((a, b) => a.offset - b.offset);
    let currentIndex = 0;
    const fragment = matches.reduce((acc, { offset, term }) => {
      if (offset < currentIndex) return acc;
      const textBefore = textContent.substring(currentIndex, offset);
      if (textBefore) {
        acc.appendChild(document.createTextNode(textBefore));
      }
      const markedTerm = document.createElement('mark');
      markedTerm.textContent = term;
      acc.appendChild(markedTerm);
      currentIndex = offset + term.length;
      return acc;
    }, document.createDocumentFragment());
    const textAfter = textContent.substring(currentIndex);
    if (textAfter) {
      fragment.appendChild(document.createTextNode(textAfter));
    }
    element.innerHTML = '';
    element.appendChild(fragment);
  });
}

/**
 * Fetches JSON data from a given source URL.
 */
export async function fetchData(source) {
  const response = await fetch(source);
  if (!response.ok) {
    // eslint-disable-next-line no-console
    console.error('error loading API response', response);
    return null;
  }
  const json = await response.json();
  if (!json) {
    // eslint-disable-next-line no-console
    console.error('empty API response', source);
    return null;
  }
  return json.data;
}

/**
 * Renders a single search result <li>.
 */
function renderResult(result, searchTerms, titleTag) {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.href = result.path;

  // If there's an image, create the optimized picture
  if (result.image) {
    const wrapper = document.createElement('div');
    wrapper.className = 'search-result-image';
    const pic = createOptimizedPicture(result.image, '', false, [{ width: '375' }]);
    wrapper.append(pic);
    a.append(wrapper);
  }

  // Title
  if (result.title) {
    const title = document.createElement(titleTag);
    title.className = 'search-result-title';
    const link = document.createElement('a');
    link.href = result.path;
    link.textContent = result.title;
    highlightTextElements(searchTerms, [link]);
    title.append(link);
    a.append(title);
  }

  // Description
  if (result.description) {
    const description = document.createElement('p');
    description.textContent = result.description;
    highlightTextElements(searchTerms, [description]);
    a.append(description);
  }

  li.append(a);
  return li;
}

/**
 * Clears the <ul> by setting innerHTML = ''.
 */
function clearSearchResults(resultsUl) {
  resultsUl.innerHTML = '';
}

/**
 * Fully clears search and removes ?q= from the URL.
 */
function clearSearch(resultsUl) {
  clearSearchResults(resultsUl);
  if (window.history.replaceState) {
    const url = new URL(window.location.href);
    url.search = '';
    searchParams.delete('q');
    window.history.replaceState({}, '', url.toString());
  }
}

/**
 * Renders multiple results into the <ul>.
 */
async function renderResults(resultsUl, config, filteredData, searchTerms) {
  // Clear existing
  clearSearchResults(resultsUl);

  const headingTag = resultsUl.dataset.h;

  if (filteredData.length) {
    resultsUl.classList.remove('no-results');
    filteredData.forEach((result) => {
      const li = renderResult(result, searchTerms, headingTag);
      resultsUl.append(li);
    });
  } else {
    const noResultsMessage = document.createElement('li');
    resultsUl.classList.add('no-results');
    noResultsMessage.textContent = config.placeholders.searchNoResults || 'No results found.';
    resultsUl.append(noResultsMessage);
  }
}

/**
 * Used for sorting search hits by minIdx.
 */
function compareFound(hit1, hit2) {
  return hit1.minIdx - hit2.minIdx;
}

/**
 * Filters the data based on matching search terms in header/title/description.
 */
function filterData(searchTerms, data) {
  const foundInHeader = [];
  const foundInMeta = [];

  data.forEach((result) => {
    let minIdx = -1;

    // Check header/title
    searchTerms.forEach((term) => {
      const idx = (result.header || result.title).toLowerCase().indexOf(term);
      if (idx < 0) return;
      if (minIdx < idx) minIdx = idx;
    });

    if (minIdx >= 0) {
      foundInHeader.push({ minIdx, result });
      return;
    }

    // Check meta (title + description + last part of path)
    const metaContents = `${result.title} ${result.description} ${result.path.split('/').pop()}`.toLowerCase();
    searchTerms.forEach((term) => {
      const idx = metaContents.indexOf(term);
      if (idx < 0) return;
      if (minIdx < idx) minIdx = idx;
    });

    if (minIdx >= 0) {
      foundInMeta.push({ minIdx, result });
    }
  });

  // Sort and combine
  return [
    ...foundInHeader.sort(compareFound),
    ...foundInMeta.sort(compareFound),
  ].map((item) => item.result);
}

/**
 * Handles typing in the search box and updates results.
 */
async function handleSearch(e, block, config, resultsUl) {
  const searchValue = e.target.value;
  searchParams.set('q', searchValue);

  // Update the URL ?q= param
  if (window.history.replaceState) {
    const url = new URL(window.location.href);
    url.search = searchParams.toString();
    window.history.replaceState({}, '', url.toString());
  }

  // If too short, clear
  if (searchValue.length < 3) {
    clearSearch(resultsUl);
    return;
  }

  // Split search into terms
  const searchTerms = searchValue.toLowerCase().split(/\s+/).filter((term) => !!term);

  // Fetch + filter
  const data = await fetchData(config.source);
  const filteredData = filterData(searchTerms, data);

  // Render
  await renderResults(resultsUl, config, filteredData, searchTerms);
}

/**
 * Creates the <ul class="search-results"> element.
 */
function searchResultsContainer(block) {
  const results = document.createElement('ul');
  results.className = 'search-results';
  results.dataset.h = findNextHeading(block);
  return results;
}

/**
 * Creates the <input type="search"> element and wires up events.
 */
function searchInput(block, config, resultsUl) {
  const input = document.createElement('input');
  input.setAttribute('type', 'search');
  input.className = 'search-input';

  const searchPlaceholder = config.placeholders.searchPlaceholder || 'Search...';
  input.placeholder = searchPlaceholder;
  input.setAttribute('aria-label', searchPlaceholder);

  // On typing, do a search
  input.addEventListener('input', (e) => {
    handleSearch(e, block, config, resultsUl);
  });

  // On Esc key, clear
  input.addEventListener('keyup', (e) => {
    if (e.code === 'Escape') {
      clearSearch(resultsUl);
    }
  });

  return input;
}

/**
 * Creates the search icon span.
 */
function searchIcon() {
  const icon = document.createElement('span');
  icon.classList.add('icon', 'icon-search');
  return icon;
}

/**
 * Creates the overall .search-box container with the icon + input.
 */
function searchBox(block, config, resultsUl) {
  const box = document.createElement('div');
  box.classList.add('search-box');
  box.append(searchIcon(), searchInput(block, config, resultsUl));
  return box;
}

/**
 * Main entry: Called by the framework to "decorate" the search block.
 *
 * 1. Clears the original block content.
 * 2. Creates and appends the search box into the nav block.
 * 3. Creates the <ul> and appends it to a custom container (`.search-results-custom`).
 * 4. Initializes any existing ?q= param search.
 */
export default async function decorate(block) {
  const placeholders = await fetchPlaceholders();
  const source = block.querySelector('a[href]') ? block.querySelector('a[href]').href : '/query-index.json';

  // Clear the original block
  block.innerHTML = '';

  // Create the <ul> that will hold search results
  const resultsUl = searchResultsContainer(block);

  // Append only the search box to the original block (inside the nav)
  block.append(
    searchBox(block, { source, placeholders }, resultsUl),
  );

  // Append the <ul class="search-results"> to your custom container outside the nav
  const customSearchResults = document.querySelector('.search-results-custom');
  if (customSearchResults) {
    customSearchResults.append(resultsUl);
  } else {
    // If .search-results-custom isn't found, log an error or handle gracefully
    console.error('Could not find .search-results-custom container in the DOM.');
  }

  // If there's an existing ?q= param, run the search immediately
  if (searchParams.get('q')) {
    const input = block.querySelector('input');
    input.value = searchParams.get('q');
    input.dispatchEvent(new Event('input'));
  }

  // Finally, decorate icons inside the block
  decorateIcons(block);
}
