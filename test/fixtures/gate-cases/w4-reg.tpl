# Looser than main: from hatchery (hatchery#138 fails its check). gh 2.78 edits hatchery#138 in each (URL repo beats -R
# and applies to every issue in the argv; gh's URL reader takes /pull/, any-case scheme, and %-encoded paths).
@H	gh issue edit 138 https://github.com/joshgaskin/hatchery/pull/138 -R joshgaskin/catalina --add-label @L
@H	gh issue edit 138 HTTPS://github.com/joshgaskin/hatchery/issues/138 -R joshgaskin/catalina --add-label @L
@H	gh issue edit 138 https://github.com/joshgaskin/hatchery/issues/%31%33%38 -R joshgaskin/catalina --add-label @L
@H	gh issue edit 138 Https://github.com/joshgaskin/hatchery/issues/138 -R joshgaskin/catalina --add-label @L
@H	gh issue edit 138 -R joshgaskin/hatchery.git --add-label @L
# controls: the URL forms the gate does read
@H	gh issue edit 138 https://github.com/joshgaskin/hatchery/issues/138 -R joshgaskin/catalina --add-label @L
@H	gh issue edit 138 https://github.com/joshgaskin/h%61tchery/issues/138 -R joshgaskin/catalina --add-label @L
@H	gh issue edit 138 -R joshgaskin/catalina --add-label @L
