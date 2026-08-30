function toggleCSS(enable) {
	var styles = Array.from(document.querySelectorAll("style"));
	for(var j = 0, k = styles.length; j<k; j++) {
		styles[j].disabled = !enable;
	}
	var stylesheets = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
	for(var j = 0, k = stylesheets.length; j<k; j++) {
		stylesheets[j].disabled = !enable;
	}
}

function toggleClassname(enable, className) {
	document.documentElement.classList.toggle(className, !enable);
}

document.addEventListener("click", function(event) {
	if(!("closest" in event.target)) {
		return;
	}

	let toggle = event.target.closest(".toggle");
	if(!toggle) {
		return;
	}
	let wasPressed = toggle.getAttribute("aria-pressed") === 'true';
	let isPressed = !wasPressed;
	toggle.setAttribute("aria-pressed", String(isPressed));

	// for CSS
	if(toggle.classList.contains("toggle-css")) {
		toggleCSS(isPressed);
	}

	// for Web Fonts
	let className = toggle.getAttribute("data-toggle-class");
	if(className) {
		toggleClassname(isPressed, className);
	}

	// Deviation from source: the source's "ai-mode" branch here required a
	// caller-supplied id starting with "ai-mode" (toggle-button.webc:id is
	// otherwise undefined, which crashed getAttribute("id").startsWith(...))
	// and imported /static/js/ai-mode.js, a file this theme does not ship.
	// Deliberately dropped — do not restore without also porting ai-mode.js.
});
