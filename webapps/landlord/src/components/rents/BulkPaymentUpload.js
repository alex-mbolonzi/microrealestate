import * as React from 'react';
import { useRef, useState, useContext } from 'react';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { LuAlertTriangle, LuDownload, LuUpload } from 'react-icons/lu';
import { toast } from 'sonner';
import useTranslation from 'next-translate/useTranslation';
import { apiFetcher } from '../../utils/fetch';
import { StoreContext } from '../../store';
import config from '../../config';

const CHUNK_SIZE = 5; // Process 5 payments at a time

export default function BulkPaymentUpload({ isOpen, onClose, onSuccess }) {
  const { t } = useTranslation('common');
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);
  const store = useContext(StoreContext);

  const handleFileChange = (event) => {
    const selectedFile = event.target.files[0];
    if (selectedFile && selectedFile.type === 'text/csv') {
      setFile(selectedFile);
    } else {
      toast.error(t('Please select a valid CSV file'));
      event.target.value = null;
    }
  };

  const handleDownloadTemplate = () => {
    const headers = ['tenant_id', 'payment_date', 'payment_type', 'payment_reference', 'amount'];
    const csvContent = headers.join(',') + '\n' + 
      '026551,09/01/2024,Mpesa,SI171M8709,5600\n' +  // Example row
      '046006,09/01/2024,Mpesa,SI121QSOR6,2000';     // Another example row
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'payment_upload_template.csv';
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  };

  const handleUpload = async () => {
    if (!file) {
      toast.error(t('Please select a file first'));
      return;
    }

    setLoading(true);
    setProgress(0);

    try {
      // Ensure we have a valid token before starting the upload
      const token = await ensureValidToken();
      if (!token) {
        throw new Error('Failed to get valid token');
      }

      // Create form data with the file and term
      const formData = new FormData();
      formData.append('file', file);
      // Get current term from store or URL
      const currentTerm = store.rent.periodAsString;
      formData.append('term', currentTerm);

      // Create a promise that wraps XMLHttpRequest to track progress
      const uploadWithProgress = () => {
        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          
          xhr.upload.addEventListener('progress', (event) => {
            if (event.lengthComputable) {
              const percentComplete = (event.loaded / event.total) * 100;
              setProgress(percentComplete);
            }
          });

          xhr.addEventListener('load', async () => {
            console.log('Response status:', xhr.status);
            console.log('Response headers:', xhr.getAllResponseHeaders());
            
            const responseText = xhr.responseText;
            console.log('Response text:', responseText);
            
            try {
              const responseData = JSON.parse(responseText);
              if (xhr.status >= 200 && xhr.status < 300) {
                resolve(responseData);
              } else {
                reject(new Error(responseData.error || responseData.detail || 'Failed to process payments'));
              }
            } catch (e) {
              console.error('Failed to parse response as JSON:', e);
              reject(new Error('Invalid response from server'));
            }
          });

          xhr.addEventListener('error', () => {
            reject(new Error('Network error occurred'));
          });

          xhr.addEventListener('abort', () => {
            reject(new Error('Upload aborted'));
          });

          // Open and send the request
          xhr.open('POST', `${config.BASE_PATH}/api/paymentprocessor/process-payments`);
          xhr.setRequestHeader('Authorization', `Bearer ${token}`);
          xhr.setRequestHeader('organizationid', store.organization?.selected?._id);
          xhr.send(formData);
        });
      };

      // Execute the upload
      console.log('Request details:', {
        url: `${config.BASE_PATH}/api/paymentprocessor/process-payments`,
        organizationId: store.organization?.selected?._id,
        fileSize: file.size,
        fileName: file.name
      });

      const responseData = await uploadWithProgress();
      
      // Calculate statistics
      const total = responseData.summary?.total || 0;
      const successful = responseData.summary?.successful || 0;
      const failed = responseData.summary?.failed || 0;

      // Create detailed error message for failed records
      let errorDetails = '';
      if (failed > 0) {
        const failedRecords = responseData.results
          .filter(r => !r.success)
          .map(r => `\n• Tenant ${r.tenant_id}: ${r.message}`)
          .join('');
        errorDetails = `\n\nFailed records:${failedRecords}`;
      }

      // Show summary with details
      if (failed > 0) {
        toast.error(
          t('Upload completed with errors: {{successful}} successful, {{failed}} failed.{{details}}', {
            successful,
            failed,
            details: errorDetails
          })
        );
      } else {
        toast.success(
          t('Upload completed successfully: {{total}} payments processed', {
            total
          })
        );
      }

      onSuccess?.();
      onClose();
    } catch (error) {
      console.error('Upload error:', error);
      toast.error(error.message || t('Failed to upload file'));
    } finally {
      setLoading(false);
      setProgress(0);
      setFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = null;
      }
    }
  };

  const ensureValidToken = async () => {
    let refreshResult;
    try {
      refreshResult = await store.user.refreshTokens();
      if (refreshResult.status !== 200) {
        throw new Error('Token refresh failed: ' + (refreshResult.error?.message || 'Unknown error'));
      }
      console.log('Tokens refreshed successfully');
      return store.user.token;
    } catch (refreshError) {
      console.error('Initial token refresh failed:', refreshError);
      toast.error(t('Authentication error. Please log in again.'));
      window.location.assign(`${config.BASE_PATH}`);
      return null;
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('Upload Bulk Payments')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <Alert variant="info" className="text-sm">
            <LuAlertTriangle className="h-4 w-4" />
            <div>
              <p>{t('Please ensure your CSV file follows the required format.')}</p>
              <p>{t('Download the template below for reference.')}</p>
            </div>
          </Alert>

          <div className="flex flex-col gap-4">
            <Button
              variant="outline"
              onClick={handleDownloadTemplate}
              className="w-full"
            >
              <LuDownload className="mr-2 h-4 w-4" />
              {t('Download Template')}
            </Button>

            <input
              type="file"
              accept=".csv"
              onChange={handleFileChange}
              ref={fileInputRef}
              className="hidden"
            />
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              className="w-full"
            >
              <LuUpload className="mr-2 h-4 w-4" />
              {t('Select CSV File')}
            </Button>
            {file && (
              <p className="text-sm text-gray-500">
                {t('Selected file')}: {file.name}
              </p>
            )}

            {loading && progress > 0 && (
              <div className="w-full bg-gray-200 rounded-full h-2.5">
                <div
                  className="bg-blue-600 h-2.5 rounded-full"
                  style={{ width: `${progress}%` }}
                ></div>
              </div>
            )}

            <Button
              onClick={handleUpload}
              disabled={!file || loading}
              className="w-full"
            >
              {loading ? t('Uploading... {{progress}}%', { progress: Math.round(progress) }) : t('Upload Payments')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
