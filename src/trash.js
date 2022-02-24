driver.getWindowHandle().then((window) => {
    driver.executeScript(() => {
        window.addEventListener('customEvent', function (e) {
            window.content = e.detail;
        });
    }).then(() => {
        driver.executeScript("return window.content['data']").then((val) => {
            console.log("Initial result from event: " + val);
        });
    });
});


var counter = 0;
driver.wait(() => {
    console.log(counter);
    if (counter++ === 1000) {
        driver.executeScript(() => {
            var event = new CustomEvent("customEvent", {
                detail: {
                    data: "TEST Data from custom event"
                }
            });

            window.dispatchEvent(event);
        });
    }

    return driver.executeScript('return typeof window.content["data"] !== "undefined"');
});

driver.executeScript('return window.content["data"]').then((val) => {
    console.log("Result from event: " + val);
});


//


driver.getWindowHandle().then(function (window) {
    driver.executeScript(function () {
        window.addEventListener('customEvent', function (e) {
            console.log(content = e.detail);
            //return content['data'];
        })
    }).then(function () {
        driver.manage().timeouts().implicitlyWait(20000);
        driver.executeScript("return content['data']").then(function (val) {
            console.log(val);
        })
    })
});
