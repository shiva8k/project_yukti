import asyncio

import main

result = asyncio.run(
    main.next_step(
        command="Open Amazon India",
        elements="[]",
        history="[]",
        current_url="chrome://newtab/",
        viewport='{"width": 1280, "height": 720}',
        file=None,
    )
)
print(result)
