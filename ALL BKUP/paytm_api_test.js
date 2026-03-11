 const https = require('https');
/*
* import checksum generation utility
* You can get this utility from https://developer.paytm.com/docs/checksum/
*/
const PaytmChecksum = require('paytmchecksum');
var paytmParams = {};
paytmParams.body = {
    "mid": "cbeXrV55846175991466",
    "fromDate"   : "2021-01-25T23: 59: 35+08: 00",
    "toDate"       : "2021-02-02T23: 59: 35+08: 00",
    "orderSearchType"   : "TRANSACTION",
    "orderSearchStatus"  :"SUCCESS",
    "pageNumber"   : 1,
    "pageSize"   : 50,
    "paymentModes": {
        "searchKey" : "VAN_ID",
        "searchValue" : "PYI3831611899004",
    }
};
/*
* Generate checksum by parameters we have in body
* Find your Merchant Key in your Paytm Dashboard at https://dashboard.paytm.com/next/apikeys
*/
PaytmChecksum.generateSignature(JSON.stringify(paytmParams.body), "pMXxBbEFlPHZBlRa").then(function(checksum){
    paytmParams.head = {
        "signature": checksum,
        "tokenType":"CHECKSUM",
        "requestTimestamp":"1758375608"
    };
    var post_data = JSON.stringify(paytmParams);
    var options = {
        /* for Staging */
        hostname: 'securegw-stage.paytm.in',
        port: 443,
        path: '/merchant-passbook/search/list/order/v2',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': post_data.length
        }
    };
    var response = "";
    var post_req = https.request(options, function(post_res) {
        post_res.on('data', function (chunk) {
            response += chunk;
        });
        post_res.on('end', function(){
            console.log('Response: ', response);
        });
    });
    post_req.write(post_data);
    post_req.end();
});
