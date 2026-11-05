'use strict';

const sections = Array.from(document.querySelectorAll('.manual-section'));
const links = Array.from(document.querySelectorAll('.sidebar nav a'));
const search = document.getElementById('manual-search');
const searchStatus = document.getElementById('search-status');
const contents = document.getElementById('contents');
const mobile = window.matchMedia('(max-width: 720px)');

document.querySelectorAll('.enhancement').forEach(function (element) {
    element.hidden = false;
});

function syncContents() {
    contents.open = !mobile.matches;
}
syncContents();
if (mobile.addEventListener) {
    mobile.addEventListener('change', syncContents);
} else {
    mobile.addListener(syncContents);
}

function filterSections() {
    const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let matches = 0;
    sections.forEach(function (section) {
        const haystack = section.textContent.toLowerCase() + ' ' + (section.dataset.keywords || '');
        const match = terms.every(function (term) { return haystack.includes(term); });
        section.hidden = !match;
        if (match) {
            matches++;
        }
    });
    // Searching includes every effects map, so expose them in the results too.
    if (terms.length) {
        bankPanels.forEach(function (panel) { panel.hidden = false; });
    } else {
        const selected = bankButtons.find(function (button) {
            return button.getAttribute('aria-pressed') === 'true';
        });
        selectBank(selected.dataset.bank);
    }
    searchStatus.textContent = terms.length ? (matches ? matches + ' matching section' + (matches === 1 ? '' : 's') + '. Clear to show the full manual.' : 'No matching sections. Try “loop”, “sound”, “reverse”, or “record”.') : '';
}
search.addEventListener('input', filterSections);
document.getElementById('clear-search').addEventListener('click', function () {
    search.value = '';
    filterSections();
    search.focus();
});
document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && document.activeElement === search) {
        search.value = '';
        filterSections();
    }
});

// Section links always reveal their destination, including from filtered results.
document.querySelectorAll('a[href^="#"]').forEach(function (link) {
    link.addEventListener('click', function () {
        if (link.getAttribute('href') !== '#manual-search') {
            search.value = '';
            filterSections();
        }
        if (mobile.matches && link.closest('.sidebar')) {
            contents.open = false;
        }
    });
});

const bankButtons = Array.from(document.querySelectorAll('[data-bank]'));
const bankPanels = Array.from(document.querySelectorAll('.bank-panel'));
function selectBank(id) {
    bankButtons.forEach(function (button) {
        button.setAttribute('aria-pressed', String(button.dataset.bank === id));
    });
    bankPanels.forEach(function (panel) {
        panel.hidden = panel.id !== id;
    });
}
bankButtons.forEach(function (button) {
    button.addEventListener('click', function () { selectBank(button.dataset.bank); });
});
selectBank('bank-play');

if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
            if (entry.isIntersecting) {
                links.forEach(function (link) {
                    if (link.hash === '#' + entry.target.id) {
                        link.setAttribute('aria-current', 'location');
                    } else {
                        link.removeAttribute('aria-current');
                    }
                });
            }
        });
    }, { rootMargin: '-10% 0px -65% 0px' });
    sections.forEach(function (section) { observer.observe(section); });
}

let printDetails = [];
window.addEventListener('beforeprint', function () {
    printDetails = Array.from(document.querySelectorAll('details.help')).map(function (detail) {
        const state = { detail: detail, open: detail.open };
        detail.open = true;
        return state;
    });
});
window.addEventListener('afterprint', function () {
    printDetails.forEach(function (state) { state.detail.open = state.open; });
});
document.getElementById('print-manual').addEventListener('click', function () { window.print(); });
