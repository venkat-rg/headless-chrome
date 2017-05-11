import Cdp from 'chrome-remote-interface'
import config from '../config'
import { log, sleep } from '../utils'
import AWS  from 'aws-sdk'

const defaultPrintOptions = {
  landscape: false,
  displayHeaderFooter: false,
  printBackground: true,
  scale: 1,
  paperWidth: 8.27, // aka A4
  paperHeight: 11.69, // aka A4
  marginTop: 0,
  marginBottom: 0,
  marginLeft: 0,
  marginRight: 0,
  pageRanges: '',
}

function cleanPrintOptionValue (type, value) {
  const types = { string: String, number: Number, boolean: Boolean }
  return new types[type](value)
}

function makePrintOptions (options = {}) {
  return Object.entries(options).reduce(
    (printOptions, [option, value]) => ({
      ...printOptions,
      [option]: cleanPrintOptionValue(typeof defaultPrintOptions[option], value),
    }),
    defaultPrintOptions
  )
}

export async function printUrlToPdf (url, printOptions = {}) {
  const LOAD_TIMEOUT = (config && config.chrome.pageLoadTimeout) || 1000 * 60
  let result
  let loaded = false

  const loading = async (startTime = Date.now()) => {
    if (!loaded && Date.now() - startTime < LOAD_TIMEOUT) {
      await sleep(100)
      await loading(startTime)
    }
  }

  const [tab] = await Cdp.List()
  const client = await Cdp({ host: '127.0.0.1', target: tab })

  const { Network, Page } = client

  Network.requestWillBeSent((params) => {
    log('Chrome is sending request for:', params.request.url)
  })

  Page.loadEventFired(() => {
    loaded = true
  })

  if (config.logging) {
    Cdp.Version((err, info) => {
      console.log('CDP version info', err, info)
    })
  }

  try {
    await Promise.all([
      Network.enable(), // https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-enable
      Page.enable(), // https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-enable
    ])

    await Page.navigate({ url }) // https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-navigate
    await loading()

    // https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-printToPDF
    const pdf = await Page.printToPDF(printOptions)
    result = pdf.data
  } catch (error) {
    console.error(error)
  }

  await client.close()

  return result
}

export async function uploadToS3 (pdf) {
  const LOAD_TIMEOUT = (config && config.chrome.uploadLoadTimeOut) || 1000 * 30

  let loaded = false

  const loading = async (startTime = Date.now()) => {
    if (!loaded && Date.now() - startTime < LOAD_TIMEOUT) {
      await sleep(100)
      await loading(startTime)
    }
  }

  // Uploading contents to s3
  var s3 = new AWS.S3({
    region: process.env.S3_REGION,
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  });

  let responseJSON = {};

  let pdfName = `${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 15)}_${new Date().getTime()}.pdf`;


  let isSuccess = false;

  s3.putObject({
    Bucket: process.env.S3_BUCKET,
    Key: pdfName, 
    Body: new Buffer(pdf, 'base64'),
    ContentType: 'application/pdf',
    ACL: 'public-read',
    // Expires in 6 minutes
    Expires: 360,
  }, function(error, data) {
      // Set loading = true, to come out of loop
      loaded = true
      
      if (!error) {
        isSuccess = true;
      }
  });

  // Call on loading
  await loading();

  if (isSuccess) {
    https://s3-us-west-2.amazonaws.com/tribelocal-prod-pdf/6n8w8nqb2pchdtdeoedfmxcwp0_1494491925447.pdf
    return `https://s3-${process.env.S3_REGION}.amazonaws.com/${process.env.S3_BUCKET}/${pdfName}`;
  }

  return null;
}

export default (async function printToPdfHandler (event) {
  const { queryStringParameters: { url, ...printParameters } } = event
  const printOptions = makePrintOptions(printParameters)
  
  let pdf

  log('Processing PDFification for', url, printOptions)

  const startTime = Date.now()

  let pdfURL = null;

  try {
    pdf = await printUrlToPdf(url, printOptions)

    // Uploading contents to s3
    pdfURL = await uploadToS3(pdf)

  } catch (error) {
    console.error('Error printing pdf for', url, error)
    throw new Error('Unable to print pdf')
  }

  const endTime = Date.now()

  return {
    statusCode: 200,
    body: JSON.stringify({
      url: pdfURL
    }),
    headers: {
      'Content-Type': 'application/json'
    }
  }

  return responseJSON;
})
